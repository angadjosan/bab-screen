import { NextRequest, NextResponse } from "next/server";
import { getSlackFileUrl, validImageSignature } from "../../../../lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const fileId = request.nextUrl.searchParams.get("file") ?? "";
  const signature = request.nextUrl.searchParams.get("sig") ?? "";
  if (!validImageSignature(fileId, signature)) {
    return new NextResponse("Invalid image link", { status: 403 });
  }

  try {
    const url = await getSlackFileUrl(fileId);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      cache: "no-store",
    });
    // Without the files:read scope Slack answers with an HTML login page instead of the image.
    if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("image/")) {
      console.error("Slack image download failed", response.status, response.headers.get("content-type"));
      return new NextResponse("Slack image unavailable", { status: 502 });
    }

    return new NextResponse(response.body, {
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Slack image error", error);
    return new NextResponse("Slack image unavailable", { status: 502 });
  }
}
