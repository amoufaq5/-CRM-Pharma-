-- A proposal nobody was told about waits for somebody to go looking.
--
-- WHAT IS BROKEN, and 0062's browser gate measured it rather than leaving it to be guessed:
--
--     ok: and nobody was notified, because at that moment nobody could approve it  (0)
--
-- `config_change_awaiting_approval` goes to every holder of the governing grant AT THE MOMENT
-- a proposal is made. That is the right thing to do and it is not sufficient, because the two
-- states it cannot cover are the two that matter most:
--
--   * A TENANT WITH ONE OFFICER. The only compliance officer asks to arm the unattended promo
--     write-off. There is nobody to tell, so nobody is told — and when a second officer is
--     appointed next week, nothing tells them either. The request sits in a queue behind a
--     screen neither of them has a reason to open.
--   * A NEWLY APPOINTED OFFICER, in a tenant that already had one. They are now eligible to
--     decide everything pending, and were told about none of it.
--
-- Both are the same shape: the set of people who may decide a proposal CHANGES after the
-- proposal is made, and a signal raised once cannot follow it. 0062's own open list named the
-- remedy — "a sweep that re-raises for newly-eligible deciders, or a signal on the grant
-- itself" — and this is the first of those.
--
-- WHY A SWEEP AND NOT A TRIGGER ON THE GRANT. A trigger on `crm.rep_role` would be immediate
-- and would be the wrong mechanism twice. It would raise notifications from inside a role
-- grant, so an administrator appointing a colleague would own the failure of a webhook
-- enqueue; and it would cover the second case only — a proposal made with nobody to tell, in a
-- tenant whose roster never changes again, would still be invisible. A sweep answers "who
-- should know about this now" from the live state every tick, which is the question, and it is
-- the mechanism every other periodic answer in this schema already uses.
--
-- WHAT THE SWEEP ALSO DOES, and it is the half that closes the loop rather than merely
-- reporting it. A proposal with NO eligible decider is blocked on an act its author cannot
-- perform: appointing a second holder of the grant is an administrator's job, and a compliance
-- officer cannot do it for themselves. So the sweep tells the ADMINISTRATORS — the people who
-- can unblock it — and says that is what it needs, rather than telling nobody and counting it.
-- Same notification kind, because the fact is the same ("a configuration change is waiting"),
-- and a different sentence and dedup key, because what the reader can DO about it is not.
--
-- NO SECOND KIND, deliberately. 0049 made the kind vocabulary a closed list precisely so a
-- reader routing it to a webhook knows what they will get, and "waiting for a second
-- signature" is one fact with two audiences rather than two facts.
--
-- NOBODY IS NAGGED. `crm.notification`'s uniqueness is `(tenant_id, recipient, dedup_key)` and
-- the sweep reuses the key the proposal's own notice carries, so an officer who was told at
-- proposal time is not told again, every tick, forever. The cost of that choice is named in
-- 0062's open list rather than hidden: a proposal that sits for months produces exactly one
-- notice per person, and there is no escalation.

-- ---------------------------------------------------------------------------
-- The job vocabulary, which is one `CREATE OR REPLACE` since 0050.
-- ---------------------------------------------------------------------------
-- That migration moved the list out of the CHECK for exactly this moment: it had been
-- restated in four migrations by then, and adding a job now costs one function body. The
-- narrowing caveat it recorded still applies — `CREATE OR REPLACE FUNCTION` does not
-- revalidate the constraints that call it, so REMOVING a name would need
-- `DROP CONSTRAINT` + `ADD CONSTRAINT`. Widening needs no scan, because every existing row
-- already satisfies a superset.
--
-- The second copy is `JobName` in `packages/scheduler/src/jobs.ts`, which cannot be removed
-- because a `switch` needs the names at compile time; `scheduler.contract.test.ts` asserts the
-- two agree in both directions, by handing the deparsed CHECK back to Postgres to evaluate.
CREATE OR REPLACE FUNCTION crm.scheduled_jobs()
RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['relay_drain',
               'snapshot_incremental',
               'snapshot_full',
               'expiry_sweep',
               'notify_dispatch',
               'notify_prune',
               'expense_post',
               'tenant_deletion_watch',
               'notify_approvals'];
$$;

COMMENT ON FUNCTION crm.scheduled_jobs() IS
  'The jobs the scheduler runs, declared once (0050). crm.scheduled_job.job CHECKs against this, and packages/scheduler/src/jobs.ts carries the compile-time copy a switch needs; a contract test asserts the two agree.';
