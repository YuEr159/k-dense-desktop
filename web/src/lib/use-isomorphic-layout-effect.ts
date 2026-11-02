"use client";

import { useEffect, useLayoutEffect } from "react";

/**
 * `useLayoutEffect` with a body, for components Next also renders on the server.
 *
 * The client components in this app are server-rendered too, and React warns
 * when `useLayoutEffect` runs during SSR. Picking the hook by environment keeps
 * the call site uniform: a no-op on the server, and on the client a synchronous
 * callback that lands before the browser paints — which is what lets a restore
 * read `localStorage` without either a hydration mismatch or a visible flash.
 */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
