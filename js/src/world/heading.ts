// Shared turn integration for a sim-owned heading under the A/D (left/right) turn axis.
//
// THE single source of truth for the turn SIGN. The controller basis is yaw = 0 ⇒
// world -Z, with +yaw turning to the player's RIGHT; `op_input_axes` reports
// axes[0] = +1 for D (right) and -1 for A (left). So pressing D must INCREASE the
// heading — the correct integration is `heading + axisX * rate * dt`. Demos that
// hand-rolled `heading -= …` inverted left/right (every one had to be corrected by
// hand during UAT); routing every windowed demo through applyTurn makes the sign
// impossible to get wrong per-demo again.

/** Integrate one fixed step of A/D turn into a sim-owned heading (radians).
 *  `turnAxis` is `op_input_axes[0]` (+1 = D / right, -1 = A / left). */
export function applyTurn(heading: number, turnAxis: number, turnRate: number, dt: number): number {
  return heading + turnAxis * turnRate * dt;
}
