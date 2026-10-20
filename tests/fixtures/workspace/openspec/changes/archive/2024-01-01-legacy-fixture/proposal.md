# Proposal

## Why

The fixture needs a completed, archived change so archive-detail and archive-list
tests can assert stable dates, tasks and documents without depending on the live
workspace.

## What Changes

- Record a small archived capability used only by tests.

## Capabilities

### New Capabilities

- `legacy-fixture`: archived fixture capability.

### Modified Capabilities

（无）

## Impact

- Tests only.
