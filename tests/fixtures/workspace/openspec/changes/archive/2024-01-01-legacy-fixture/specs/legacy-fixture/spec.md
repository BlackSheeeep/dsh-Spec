# Spec Delta

## Purpose

Archived fixture capability used by dsh-spec tests.

## ADDED Requirements

### Requirement: Legacy fixture behavior

The system SHALL expose one archived requirement for fixture tests.

#### Scenario: Archived requirement is readable
- **WHEN** tests read the archived fixture change
- **THEN** one ADDED requirement is parsed
