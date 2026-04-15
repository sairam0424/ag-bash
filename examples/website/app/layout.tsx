import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "ag-bash",
  description: "A sandboxed bash interpreter for AI agents. Pure TypeScript with in-memory filesystem.",
  metadataBase: new URL("https://ag-bash.dev"),
  openGraph: {
    title: "ag-bash",
    description: "A sandboxed bash interpreter for AI agents. Pure TypeScript with in-memory filesystem.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ag-bash",
    description: "A sandboxed bash interpreter for AI agents. Pure TypeScript with in-memory filesystem.",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${GeistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
