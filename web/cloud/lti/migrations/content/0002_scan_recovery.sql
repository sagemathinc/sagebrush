-- A3-2 delta D2 (70042e0f; astra3 799e0517, daybreak3 b00c1dd9): which recovery
-- wake is the first.  `scan.cycle` can't tell, since normal-mode wraps raise it
-- past a later recovery id; `recovery` is set only by a recovery's reset (with
-- the cursor and the cycle, in one statement), and recovery ids come from the
-- gate's monotonic counter, so a restored row always has recovery < the id.
ALTER TABLE scan ADD COLUMN recovery INTEGER NOT NULL DEFAULT 0;
