import { pilot } from "../../../lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return pilot.status(req);
}
