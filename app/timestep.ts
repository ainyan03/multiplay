// Fixed timestep. Simulation that every client must reproduce identically
// cannot advance by however long the last animation frame happened to take.

export type FixedStepResult = { steps: number; accumulator: number };

// The step cap bounds the catch-up burst after a stall -- a tab restored from
// the background would otherwise try to replay every missed step at once.
export function advanceFixedSteps(
  accumulator: number,
  elapsed: number,
  step: number,
  maxSteps: number,
): FixedStepResult {
  if (!(step > 0)) return { steps: 0, accumulator: 0 };
  const pending = accumulator + Math.max(0, elapsed);
  const steps = Math.min(Math.floor(pending / step), maxSteps);
  const remainder = pending - steps * step;
  // Drop the backlog past the cap instead of carrying it into later frames.
  return { steps, accumulator: Math.min(remainder, step) };
}
