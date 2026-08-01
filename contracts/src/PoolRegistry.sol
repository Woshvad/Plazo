// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PoolRegistry
/// @notice Which funding book backs which product line.
///
/// @dev POOL-01: Pay-in-4, Flex and Terms fund from separate pools with no tenor
///      commingling. That guarantee is what makes the redemption story honest — a
///      lender in the Pay-in-4 book is exposed to fifty-six-day paper, and a
///      twelve-month Flex receivable appearing in it would silently lengthen their
///      duration without lengthening their lockup.
///
///      **The commingling rule is enforced by the pool, not by a signed field
///      (DEC-26).** The obvious implementation puts a product-line identifier in
///      `TermsDetail`, which sits inside `termsHash`, which means a new parity corpus
///      and a migration for a field no collection ever reads. Instead each pool
///      declares its own tenor band as immutables and answers `acceptsSchedule`. The
///      router looks the pool up here and requires it to accept the schedule in front
///      of it, so a pool physically cannot front a plan outside its band and adding
///      Flex is a deployment plus a row.
///
///      **Registration is one-way per product line.** A product line whose pool can be
///      repointed is a product line whose outstanding plans settle to yesterday's
///      book while today's lenders think they own the receivable. Retiring a line and
///      standing up a successor is a new identifier, which is exactly the visible act
///      it should be.
contract PoolRegistry is AccessControl {
    bytes32 public constant CURATOR_ROLE = keccak256("PLAZO.POOL_CURATOR");

    mapping(bytes32 productLine => address) private _pools;
    mapping(address pool => bytes32) private _lineOf;
    bytes32[] private _lines;

    event PoolRegistered(bytes32 indexed productLine, address indexed pool);

    error PoolZero();
    error LineAlreadyRegistered(bytes32 productLine, address existing);
    error PoolAlreadyRegistered(address pool, bytes32 productLine);
    error NoPoolForLine(bytes32 productLine);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURATOR_ROLE, admin);
    }

    function register(bytes32 productLine, address pool) external onlyRole(CURATOR_ROLE) {
        if (pool == address(0)) revert PoolZero();

        address existing = _pools[productLine];
        if (existing != address(0)) revert LineAlreadyRegistered(productLine, existing);

        bytes32 held = _lineOf[pool];
        if (held != bytes32(0)) revert PoolAlreadyRegistered(pool, held);

        _pools[productLine] = pool;
        _lineOf[pool] = productLine;
        _lines.push(productLine);

        emit PoolRegistered(productLine, pool);
    }

    /// @notice The pool backing a product line. Reverts if there is none.
    /// @dev Total or failing, like `ParameterRegistry.get`. A zero address returned
    ///      here would be a settlement recipient nobody can be paid at.
    function poolFor(bytes32 productLine) external view returns (address) {
        address pool = _pools[productLine];
        if (pool == address(0)) revert NoPoolForLine(productLine);
        return pool;
    }

    function isPool(address pool) external view returns (bool) {
        return _lineOf[pool] != bytes32(0);
    }

    function lineOf(address pool) external view returns (bytes32) {
        return _lineOf[pool];
    }

    function lines() external view returns (bytes32[] memory) {
        return _lines;
    }
}
