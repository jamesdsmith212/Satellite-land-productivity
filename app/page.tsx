import type { Metadata } from "next";
import { PerformanceWorkspace } from "./performance-workspace";

export const metadata: Metadata = {
  title: "Historical field performance",
  description:
    "Map crop-aware, weather-contextualised historical field performance at 10 m.",
};

export default function Home() {
  return <PerformanceWorkspace />;
}
