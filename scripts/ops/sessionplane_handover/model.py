"""Bounded verified handover model phase."""
import json

from typing import TypedDict, NotRequired

class BundleManifest(TypedDict):
    package: str
    packageSha256: str
    sourceCommit: str
    sourceTree: NotRequired[str]
    schemaTransition: NotRequired[dict[str, int]]

class LiveIdentity(TypedDict, total=False):
    process: dict
    browser: dict
    database: dict
    maintenance: dict

class CutoverReceipt(TypedDict, total=False):
    sourceCommit: str
    packageSha256: str
    oldPid: int
    newPid: int
    schemaBefore: int
    schemaAfter: int
    browserIdentityPreserved: bool
    singleCoreWriterVerified: bool

class RollbackReceipt(TypedDict, total=False):
    restoredOriginal: bool
    originalPid: int
    previousInstall: str
    databaseIntegrity: str


def save(path, value):
    path.write_text(json.dumps(value, indent=2)); path.chmod(0o600)
