import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

// Thin top loading bar that animates whenever the router is navigating /
// loading. Trickles forward while pending, then snaps to 100% and fades out
// when the new route is ready — the familiar "page is loading" affordance.
export function RouteProgress() {
  const isLoading = useRouterState({ select: (s) => s.status === "pending" || s.isLoading });
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isLoading) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setVisible(true);
      setProgress(8);
      // Trickle toward 90% so the bar feels alive without ever completing early.
      timer.current = setInterval(() => {
        setProgress((p) => (p < 90 ? p + (90 - p) * 0.12 : p));
      }, 200);
    } else {
      if (timer.current) clearInterval(timer.current);
      setProgress(100);
      hideTimer.current = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 350);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [isLoading]);

  return (
    <div
      className="route-progress"
      data-visible={visible}
      aria-hidden="true"
    >
      <div className="route-progress__bar" style={{ width: `${progress}%` }} />
    </div>
  );
}
