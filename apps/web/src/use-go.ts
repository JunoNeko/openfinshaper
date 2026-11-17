// SPDX-License-Identifier: GPL-3.0-or-later
import { useInRouterContext, useNavigate } from 'react-router-dom';

/**
 * Go to `path` in the app: by the router when there is one (the board and the fin
 * designer keep their state in memory across it), else by loading the page (a test, or
 * a page rendered on its own).
 */
export function useGo(): (path: string) => void {
  const routed = useInRouterContext();
  // Whether there is a router doesn't change while a component is mounted.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const navigate = routed ? useNavigate() : null;
  return (path) => {
    if (navigate) void navigate(path);
    else window.location.assign(path);
  };
}
