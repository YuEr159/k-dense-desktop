/**
 * Window geometry decisions, kept out of the Electron entry point.
 *
 * These are the parts worth testing without a display: whether a saved
 * rectangle is still usable, and which parts of the current one are worth
 * saving. The Electron calls around them are one line each; the rules are not.
 */

/** Below this a restored window is more of a mistake than a preference. */
const MIN_USABLE = 200;

/**
 * Whether `bounds` overlaps any display's work area.
 *
 * Intersection, not containment: a window deliberately hanging off the edge of
 * a screen is a legitimate choice, while one wholly on a monitor that is no
 * longer connected is how the app "opens nothing" after an undock.
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {{x:number,y:number,width:number,height:number}[]} workAreas
 */
export function boundsVisibleSomewhere(bounds, workAreas) {
  return workAreas.some(
    (area) =>
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y,
  );
}

/**
 * Turn a stored `windowState` into BrowserWindow options, or nothing.
 *
 * Returning `{}` on any doubt is deliberate: the caller spreads the result
 * into the constructor, so "no opinion" has to mean "use the defaults".
 *
 * @param {unknown} saved  the `windowState` value from shell.json
 * @param {{x:number,y:number,width:number,height:number}[]} workAreas
 * @returns {{bounds?: object, maximized?: boolean}}
 */
export function restoreWindowState(saved, workAreas) {
  if (!saved || typeof saved !== "object") return {};
  const bounds = saved.bounds;
  if (!bounds || !["x", "y", "width", "height"].every((k) => Number.isFinite(bounds[k]))) return {};
  if (bounds.width < MIN_USABLE || bounds.height < MIN_USABLE) return {};
  if (!boundsVisibleSomewhere(bounds, workAreas)) return {};
  return { bounds, maximized: saved.maximized === true };
}

/**
 * What to persist for the next launch.
 *
 * `normalBounds` rather than the current one: a maximized window reports the
 * screen size, and restoring that would leave the next launch maximized at a
 * size it can no longer un-maximize to sensibly.
 *
 * @returns {{bounds: object, maximized: boolean} | null} null means "do not save"
 */
export function windowStateToSave({ normalBounds, maximized, fullScreen }) {
  if (fullScreen) return null;
  if (!normalBounds) return null;
  if (normalBounds.width < MIN_USABLE || normalBounds.height < MIN_USABLE) return null;
  return { bounds: normalBounds, maximized: Boolean(maximized) };
}
