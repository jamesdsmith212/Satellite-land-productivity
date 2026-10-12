import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "satellite-productivity-detection.local";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const socialImage = `${protocol}://${host}/og.png`;
  const description =
    "Crop-aware, weather-contextualised historical field performance mapped at 10 m.";

  return {
    title: {
      default: "Satellite Productivity Detection",
      template: "%s · Satellite Productivity Detection",
    },
    description,
    openGraph: {
      title: "Satellite Productivity Detection · Historical field performance",
      description,
      images: [
        {
          url: socialImage,
          width: 1733,
          height: 908,
          alt: "Satellite Productivity Detection historical field performance map",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Satellite Productivity Detection · Historical field performance",
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
