# Separate active data from change history

fin stores current domain records separately from immutable, structured change records. Active
transactions are updated in place and deleted immediately rather than versioned or soft-deleted,
while change records retain enough detail to explain edits and recreate deleted data; this keeps
normal queries simple without sacrificing a human-readable audit trail.
