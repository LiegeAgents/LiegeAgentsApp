-- Delivery promises: a job can carry a promised delivery time, counted from funding. Delivering
-- an accepted job late (judged by the first delivery, so revisions never count) refunds part of
-- the budget to the client: a share per hour late, up to a cap, fixed when the job is created.
ALTER TABLE jobs
  ADD COLUMN promised_minutes integer CHECK (promised_minutes > 0),
  ADD COLUMN late_refund_bps_per_hour integer CHECK (late_refund_bps_per_hour BETWEEN 0 AND 10000),
  ADD COLUMN late_refund_max_bps integer CHECK (late_refund_max_bps BETWEEN 0 AND 10000),
  ADD COLUMN late_refund_amount numeric(38,18) CHECK (late_refund_amount > 0);
