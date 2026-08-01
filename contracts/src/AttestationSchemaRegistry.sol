// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AttestationSchemaRegistry
/// @notice The published, versioned schemas a Passport record is scored under.
///
/// @dev PASS-05. A commitment is only meaningful against a schema: `keccak256(version ‖
///      salt ‖ recordHash)` says nothing at all unless the world can find out what a
///      record is and how it becomes a tier. Without this contract the Passport is a
///      hash the operator can reinterpret at will, which is worse than a readable
///      record because it also looks rigorous.
///
///      **Append-only.** A published version is never edited or withdrawn. Every
///      commitment ever written names the schema version it was scored under, and a
///      schema that could change under a commitment would make historical records
///      unverifiable — which is precisely the failure the commitment exists to prevent.
///      Correcting a schema means publishing the next version.
///
///      **The content hash is the binding artefact, not the URI.** The URI is a
///      convenience for finding the document; the hash is what makes the document the
///      one that was meant. A registry storing only a link is a registry that trusts
///      whoever controls the host.
contract AttestationSchemaRegistry is AccessControl {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PLAZO.SCHEMA_PUBLISHER");

    struct SchemaVersion {
        uint64 version;
        uint64 publishedAt;
        bytes32 contentHash;
        string uri;
    }

    mapping(bytes32 schemaId => SchemaVersion[]) private _versions;
    bytes32[] private _schemaIds;

    event SchemaPublished(
        bytes32 indexed schemaId, uint64 indexed version, bytes32 contentHash, string uri
    );

    error NoSuchSchema(bytes32 schemaId);
    error ContentHashZero();
    error VersionNotSequential(uint64 expected, uint64 provided);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PUBLISHER_ROLE, admin);
    }

    /// @notice Publish the next version of a schema.
    /// @dev Versions are dense and sequential so "version 3" is unambiguous and a gap
    ///      cannot be mistaken for a withdrawal.
    function publish(bytes32 schemaId, uint64 version, bytes32 contentHash, string calldata uri)
        external
        onlyRole(PUBLISHER_ROLE)
    {
        if (contentHash == bytes32(0)) revert ContentHashZero();

        SchemaVersion[] storage versions = _versions[schemaId];
        uint64 expected = uint64(versions.length) + 1;
        if (version != expected) revert VersionNotSequential(expected, version);

        if (versions.length == 0) _schemaIds.push(schemaId);

        versions.push(
            SchemaVersion({
                version: version,
                publishedAt: uint64(block.timestamp),
                contentHash: contentHash,
                uri: uri
            })
        );

        emit SchemaPublished(schemaId, version, contentHash, uri);
    }

    function latest(bytes32 schemaId) external view returns (SchemaVersion memory) {
        SchemaVersion[] storage versions = _versions[schemaId];
        if (versions.length == 0) revert NoSuchSchema(schemaId);
        return versions[versions.length - 1];
    }

    function versionAt(bytes32 schemaId, uint64 version) external view returns (SchemaVersion memory) {
        SchemaVersion[] storage versions = _versions[schemaId];
        if (version == 0 || version > versions.length) revert NoSuchSchema(schemaId);
        return versions[version - 1];
    }

    function versionCount(bytes32 schemaId) external view returns (uint256) {
        return _versions[schemaId].length;
    }

    function schemaIds() external view returns (bytes32[] memory) {
        return _schemaIds;
    }
}
