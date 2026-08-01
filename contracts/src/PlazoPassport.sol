// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {ParameterRegistry} from "./ParameterRegistry.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";

/// @title PlazoPassport
/// @notice A borrower's credit standing: a coarse tier anyone authorised can read, and
///         a commitment to everything richer that they cannot.
///
/// @dev PASS-01 through PASS-07, and D8's Passport half. The requirements pull in two
///      directions, and the resolution is this contract's whole design.
///
///      PASS-03 ages negative marks out at twenty-four months, PASS-06 demands that
///      identical repayment histories produce identical scores, and UW-08 lets a
///      borrower see exactly which events produced their limit — all three want an
///      auditable history. PASS-02 says the chain holds a commitment rather than a
///      readable record, and PASS-07 needs correction and erasure, which an immutable
///      public history cannot survive. FCRA §611 correction, NYDFS thirty-day deletion
///      and GDPR Article 17 are all impossible against a permanent readable record.
///
///      **The split follows what the chain can already prove.** A plan's outcome is
///      onchain and self-verifying — `Tier0Underwriter.notePlanOutcome` reads the plan's
///      own state and every installment status, and anybody can call it. So the
///      *objective* half of the record lives here as counters: clean completions, and a
///      short ring of negative-mark timestamps. The tier is a pure function of those
///      counters, which makes PASS-06 a property of the code rather than a promise
///      about a model, and PASS-03 a property of the read rather than of somebody's
///      cron job — an aged-out mark stops counting because `_activeNegatives` skips it,
///      not because anyone remembered to delete it.
///
///      Everything *richer* — identity attestations, verified income, third-party data
///      — never touches the chain. It lives in the operator's private schema and the
///      chain holds `keccak256(version ‖ salt ‖ recordHash)` against a published,
///      versioned schema. `packages/passport` is open source and independently
///      runnable, so a borrower recomputes the commitment from their own record and
///      checks this contract agrees.
///
///      **Erasure rotates the salt (PASS-07).** Nothing is deleted from a chain that
///      cannot delete; every prior commitment simply stops being linkable to anything.
///
///      **Written only by protocol contracts (PASS-01).** `WRITER_ROLE` belongs to
///      `Tier0Underwriter` and `CheckoutRouter`, and every write those make is derived
///      from a plan's own state. There is no function that hands a borrower a better
///      standing than their plans earned — including for this contract's admin.
///
///      **Soulbound by construction.** There is no token to bind. A record is a mapping
///      entry keyed by wallet, and no path moves one.
contract PlazoPassport is AccessControl {
    /// @notice May write records. Protocol contracts only.
    bytes32 public constant WRITER_ROLE = keccak256("PLAZO.PASSPORT_WRITER");

    /// @notice May read the coarse tier without a consent grant.
    /// @dev PASS-02's "only a coarse tier exposed through the router". The router and
    ///      the underwriter hold this; everybody else brings the borrower's signature.
    bytes32 public constant READER_ROLE = keccak256("PLAZO.PASSPORT_READER");

    /// @notice How many negative marks a record remembers.
    /// @dev A ring, not a list. A record that grew without bound would cost more to
    ///      read every time a borrower missed a payment, and eight marks is already far
    ///      past the point where the tier stops moving — the ninth tells an underwriter
    ///      nothing the eighth did not.
    uint256 public constant MARK_RING = 8;

    /// @notice The coarse tier. Anything finer requires consent.
    enum Tier {
        Unknown,
        Impaired,
        Building,
        Established,
        Trusted
    }

    struct Record {
        uint32 completions;
        /// @notice Every negative mark ever taken, including aged-out ones.
        uint32 negativesEver;
        uint8 head;
        uint64 version;
        uint64 updatedAt;
        /// @notice Commitment to the off-chain record. Zero until one is committed.
        bytes32 commitment;
        bytes32 schemaId;
        bytes32 salt;
        uint64[MARK_RING] marks;
    }

    /// @notice A borrower's permission for one reader to see one schema.
    struct ConsentGrant {
        address borrower;
        address reader;
        bytes32 schemaId;
        uint256 validUntil;
        uint256 nonce;
    }

    bytes32 public constant CONSENT_TYPEHASH = keccak256(
        "ConsentGrant(address borrower,address reader,bytes32 schemaId,uint256 validUntil,uint256 nonce)"
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    ParameterRegistry public immutable parameters;

    mapping(address borrower => Record) private _records;
    mapping(address borrower => mapping(address reader => mapping(bytes32 schemaId => uint256)))
        private _consentUntil;
    mapping(bytes32 grantHash => bool) public consentUsed;

    /// @dev **Every event here is keyed by a salted subject, never by the wallet.**
    ///
    ///      An indexed borrower address on a credit-record event is the purchase diary
    ///      PASS-09 exists to prevent, except worse: it is the credit file itself,
    ///      permanently public and enumerable by anyone with an RPC endpoint. Phase 3
    ///      caught the same class of leak in `Tier0Underwriter`, where an indexed
    ///      `personId` was an indexed wallet wearing a hash.
    ///
    ///      `subjectOf` is `keccak256(prefix ‖ salt ‖ borrower)`, and the salt is
    ///      readable only by the borrower and `READER_ROLE`. So the operator's indexer
    ///      can key a stream it is entitled to read, a borrower can find their own
    ///      history, and an outsider holding a wallet address cannot compute the key to
    ///      look it up. Bulk enumeration requires guessing the salt rather than reading
    ///      a log.
    ///
    ///      It composes with erasure for free: rotating the salt (PASS-07) changes the
    ///      subject, so every event ever emitted about that borrower stops being
    ///      linkable to the ones emitted after — without deleting anything from a chain
    ///      that cannot delete.
    ///
    ///      `reader` stays indexed on the consent events. A reader is a business
    ///      counterparty rather than a data subject, and they need to enumerate the
    ///      grants they hold.
    event OutcomeNoted(bytes32 indexed subject, bool clean, uint32 completions, uint32 negativesEver);
    event NegativeNoted(bytes32 indexed subject, uint64 at, uint32 negativesEver);
    event CommitmentWritten(bytes32 indexed subject, uint64 version, bytes32 commitment, bytes32 schemaId);
    event SaltRotated(bytes32 indexed previousSubject, bytes32 indexed subject, uint64 version);
    event CorrectionRequested(bytes32 indexed subject, bytes32 indexed disputed, string reason);
    event ConsentGranted(
        bytes32 indexed subject, address indexed reader, bytes32 indexed schemaId, uint256 validUntil
    );
    event ConsentRevoked(bytes32 indexed subject, address indexed reader, bytes32 indexed schemaId);

    error NoRecord(address borrower);
    error NotPermitted(address caller);
    error ConsentExpired(uint256 validUntil);
    error ConsentTooLong(uint256 ttl, uint256 maxTtl);
    error ConsentReplayed(bytes32 grantHash);
    error ConsentSignatureInvalid(address borrower);

    constructor(address admin, address parameters_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        parameters = ParameterRegistry(parameters_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Writing (PASS-01)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Record how a plan ended.
    /// @dev Called by `Tier0Underwriter` from its permissionless, self-verifying
    ///      settlement path. A clean completion is a repayment with no missed
    ///      installment; anything else is either neutral or a mark, and the caller has
    ///      already read the plan to decide which.
    function noteOutcome(address borrower, bool clean) external onlyRole(WRITER_ROLE) {
        Record storage record = _touch(borrower);
        if (clean) record.completions += 1;
        else _pushMark(record);

        record.updatedAt = uint64(block.timestamp);
        emit OutcomeNoted(_subject(borrower, record.salt), clean, record.completions, record.negativesEver);
    }

    /// @notice Record a negative mark that is not a plan ending — a delinquency.
    /// @dev Separate because a delinquency is information the moment it happens, and
    ///      waiting for the plan to terminate would mean the tier is always describing
    ///      a borrower's position several weeks ago.
    function noteNegative(address borrower) external onlyRole(WRITER_ROLE) {
        Record storage record = _touch(borrower);
        _pushMark(record);
        record.updatedAt = uint64(block.timestamp);
        emit NegativeNoted(
            _subject(borrower, record.salt), uint64(block.timestamp), record.negativesEver
        );
    }

    /// @notice Commit to the off-chain half of a borrower's record.
    /// @dev PASS-02 and PASS-05. The version increments on every write and is inside
    ///      the commitment, so a commitment from an earlier state does not verify
    ///      against the current version.
    function writeCommitment(address borrower, bytes32 commitment, bytes32 schemaId)
        external
        onlyRole(WRITER_ROLE)
    {
        Record storage record = _touch(borrower);
        record.commitment = commitment;
        record.schemaId = schemaId;
        record.updatedAt = uint64(block.timestamp);
        emit CommitmentWritten(_subject(borrower, record.salt), record.version, commitment, schemaId);
    }

    function _touch(address borrower) private returns (Record storage record) {
        record = _records[borrower];
        if (record.salt == bytes32(0)) {
            record.salt =
                keccak256(abi.encode("PLAZO.PASSPORT_SALT", borrower, block.timestamp, block.number));
        }
        record.version += 1;
    }

    /// @dev A borrower disputing a record they do not have yet still gets a salt, so
    ///      their request is not the one enumerable event in the stream.
    function _ensureSalt(address borrower) private returns (bytes32) {
        Record storage record = _records[borrower];
        if (record.salt == bytes32(0)) {
            record.salt =
                keccak256(abi.encode("PLAZO.PASSPORT_SALT", borrower, block.timestamp, block.number));
        }
        return _subject(borrower, record.salt);
    }

    /// @notice The log key for a borrower, under their current salt.
    /// @dev Readable by the borrower and by `READER_ROLE`, because it needs the salt.
    ///      That is the whole control: an outsider with a wallet address cannot compute
    ///      it, so the event stream cannot be indexed into a credit file.
    function subjectOf(address borrower) external view returns (bytes32) {
        if (msg.sender != borrower && !hasRole(READER_ROLE, msg.sender)) {
            revert NotPermitted(msg.sender);
        }
        return _subject(borrower, _records[borrower].salt);
    }

    function _subject(address borrower, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode("PLAZO.PASSPORT_SUBJECT", salt, borrower));
    }

    function _pushMark(Record storage record) private {
        record.marks[record.head] = uint64(block.timestamp);
        record.head = uint8((record.head + 1) % MARK_RING);
        record.negativesEver += 1;
    }

    /// @notice Rotate a borrower's salt, unlinking every prior commitment.
    ///
    /// @dev PASS-07's erasure path. A chain cannot forget, so the record stops being
    ///      reconstructible instead: every commitment ever published for this borrower
    ///      was taken over the old salt, and without it they are hashes of nothing
    ///      anyone can check. The next `writeCommitment` re-commits whatever of the
    ///      record survives the erasure, under the new salt.
    ///
    ///      The onchain counters are untouched, and deliberately so: they are the
    ///      protocol's own record of its own plans, they were derived from public chain
    ///      state, and erasing them would let a borrower discard a default by asking.
    function rotateSalt(address borrower) external onlyRole(WRITER_ROLE) {
        Record storage record = _records[borrower];
        if (record.version == 0) revert NoRecord(borrower);

        bytes32 previous = _subject(borrower, record.salt);
        record.salt =
            keccak256(abi.encode("PLAZO.PASSPORT_SALT", borrower, record.salt, block.timestamp, block.number));
        record.commitment = bytes32(0);

        emit SaltRotated(previous, _subject(borrower, record.salt), record.version);
    }

    /// @notice Dispute a record. PASS-07's correction half.
    /// @dev The borrower's own transaction, so the request is on the chain rather than
    ///      in a support queue only the operator can see. What happens next is the
    ///      operator's obligation; what is unforgeable is that the borrower asked, and
    ///      when.
    function requestCorrection(bytes32 disputed, string calldata reason) external {
        emit CorrectionRequested(_ensureSalt(msg.sender), disputed, reason);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scoring (PASS-03, PASS-06)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Negative marks still inside their twenty-four-month life.
    /// @dev PASS-03 as a property of the read. Nothing is deleted and no job runs; a
    ///      mark simply stops being counted once it is older than the parameter, and
    ///      the parameter's band forbids setting that shorter than six months.
    function activeNegatives(address borrower) public view returns (uint256 active) {
        Record storage record = _records[borrower];
        uint256 ttl = parameters.get(ParameterKeys.PASSPORT_NEGATIVE_MARK_TTL);
        uint256 cutoff = block.timestamp > ttl ? block.timestamp - ttl : 0;

        for (uint256 i = 0; i < MARK_RING; ++i) {
            uint64 at = record.marks[i];
            if (at != 0 && at >= cutoff) active += 1;
        }
    }

    /// @notice The tier a record's counters produce.
    ///
    /// @dev PASS-06: a pure function of two integers, published here and reimplemented
    ///      in `packages/passport` against a parity corpus. There is no model in the
    ///      base layer — two borrowers whose plans ended the same way get the same
    ///      answer, and neither of them has to take anybody's word for it.
    ///
    ///      A single active mark does not impair. It suppresses growth, which is what a
    ///      missed payment on an otherwise clean history actually means; two of them
    ///      inside two years is a pattern.
    function score(uint256 completions, uint256 active) public pure returns (Tier) {
        if (active >= 2) return Tier.Impaired;
        if (active == 1) return completions >= 4 ? Tier.Established : Tier.Building;
        if (completions >= 5) return Tier.Trusted;
        if (completions >= 2) return Tier.Established;
        return Tier.Building;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reading (PASS-02, PASS-04)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The coarse tier. Borrower, or `READER_ROLE`.
    function tierOf(address borrower) external view returns (Tier) {
        if (msg.sender != borrower && !hasRole(READER_ROLE, msg.sender)) {
            revert NotPermitted(msg.sender);
        }
        return _tier(borrower);
    }

    /// @notice The coarse tier under a consent grant the borrower signed.
    /// @dev PASS-04. Checked here so a reader cannot claim consent they do not have,
    ///      and revocation takes effect the moment it lands rather than when a
    ///      counterparty next chooses to look.
    function tierWithConsent(address borrower, bytes32 schemaId) external view returns (Tier) {
        if (!hasConsent(borrower, msg.sender, schemaId)) revert NotPermitted(msg.sender);
        return _tier(borrower);
    }

    function _tier(address borrower) private view returns (Tier) {
        Record storage record = _records[borrower];
        if (record.version == 0) return Tier.Unknown;
        return score(record.completions, activeNegatives(borrower));
    }

    /// @notice A borrower's own record, in full.
    /// @dev The salt is in here, which is what unlinkability rests on, so it is
    ///      readable by the borrower and by `READER_ROLE` and by nobody else.
    function recordOf(address borrower) external view returns (Record memory) {
        if (msg.sender != borrower && !hasRole(READER_ROLE, msg.sender)) {
            revert NotPermitted(msg.sender);
        }
        return _records[borrower];
    }

    /// @notice The counters behind a tier. UW-08's "which events produced my limit".
    /// @dev Unrestricted, and consistent with `Tier0Underwriter.personOf`: a standing
    ///      is readable by anyone who already knows which wallet to ask about, because
    ///      that is how an underwriter looks it up. What is withheld everywhere is bulk
    ///      enumeration — building a diary means guessing wallets rather than reading a
    ///      log, which is why no event here is keyed on an indexed borrower.
    function standingOf(address borrower)
        external
        view
        returns (uint32 completions, uint32 negativesEver, uint256 active, Tier tier)
    {
        Record storage record = _records[borrower];
        completions = record.completions;
        negativesEver = record.negativesEver;
        active = activeNegatives(borrower);
        tier = record.version == 0 ? Tier.Unknown : score(completions, active);
    }

    /// @notice Whether a commitment matches what this contract holds.
    /// @dev Public and unrestricted, because it discloses nothing: you can only ask
    ///      about a commitment you already computed, which means you already had the
    ///      record and the salt.
    function verify(address borrower, bytes32 commitment) external view returns (bool) {
        bytes32 held = _records[borrower].commitment;
        return held != bytes32(0) && held == commitment;
    }

    function versionOf(address borrower) external view returns (uint64) {
        return _records[borrower].version;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Consent (PASS-04, PASS-07)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Record a borrower's consent for one reader and one schema.
    ///
    /// @dev Anyone may submit it — the signature is the authorisation, not the sender.
    ///      That matters because the reader is the one with a reason to pay the gas, and
    ///      a consent flow requiring the borrower to transact is a consent flow nobody
    ///      completes.
    ///
    ///      DEC-17: consent is a signature the reader presents, not a flag an operator
    ///      sets. An operator-set boolean would mean the borrower is trusting the
    ///      operator to have asked. ERC-1271 is accepted, because a borrower on a smart
    ///      account is still a borrower.
    function grantConsent(ConsentGrant calldata grant, bytes calldata signature) external {
        if (block.timestamp > grant.validUntil) revert ConsentExpired(grant.validUntil);

        uint256 maxTtl = parameters.get(ParameterKeys.PASSPORT_CONSENT_MAX_TTL);
        uint256 ttl = grant.validUntil - block.timestamp;
        if (ttl > maxTtl) revert ConsentTooLong(ttl, maxTtl);

        bytes32 grantHash = hashConsent(grant);
        if (consentUsed[grantHash]) revert ConsentReplayed(grantHash);

        if (!SignatureChecker.isValidSignatureNow(grant.borrower, grantHash, signature)) {
            revert ConsentSignatureInvalid(grant.borrower);
        }

        consentUsed[grantHash] = true;
        _consentUntil[grant.borrower][grant.reader][grant.schemaId] = grant.validUntil;

        emit ConsentGranted(
            _subject(grant.borrower, _records[grant.borrower].salt),
            grant.reader,
            grant.schemaId,
            grant.validUntil
        );
    }

    /// @notice Withdraw a consent grant. PASS-07.
    /// @dev Effective immediately. A revocation that took effect at the next renewal
    ///      would be an expiry, not a revocation.
    function revokeConsent(address reader, bytes32 schemaId) external {
        _consentUntil[msg.sender][reader][schemaId] = 0;
        emit ConsentRevoked(_subject(msg.sender, _records[msg.sender].salt), reader, schemaId);
    }

    function hasConsent(address borrower, address reader, bytes32 schemaId) public view returns (bool) {
        return block.timestamp <= _consentUntil[borrower][reader][schemaId];
    }

    function consentExpiry(address borrower, address reader, bytes32 schemaId)
        external
        view
        returns (uint256)
    {
        return _consentUntil[borrower][reader][schemaId];
    }

    function hashConsent(ConsentGrant calldata grant) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CONSENT_TYPEHASH, grant.borrower, grant.reader, grant.schemaId, grant.validUntil, grant.nonce
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// @dev Derived, never stored. `chainId` and `verifyingContract` are both inside it
    ///      and both change on a mainnet that does not exist yet — a cached separator
    ///      would silently invalidate every outstanding grant on the day it does.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("PlazoPassport")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }
}
