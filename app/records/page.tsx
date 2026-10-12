import type { Metadata } from "next";
import { RotationWorkspace } from "../rotation-workspace";

export const metadata: Metadata = {
  title: "Crop history and evidence",
  description:
    "Review supporting crop-rotation, weather and satellite evidence.",
};

export default function RecordsPage() {
  return <RotationWorkspace />;
}
