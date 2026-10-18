import { pilot } from "../../../lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return pilot.chat(req);
}
