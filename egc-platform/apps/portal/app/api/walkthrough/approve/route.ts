import {employeeHubUrl} from "../../../../lib/format";
export const runtime = "nodejs";

/** A shared reporting login cannot approve a customer's authoritative scope. */
export async function POST() {
  return Response.json({error:"use_employee_hub_recording_review",hubUrl:employeeHubUrl()},{status:409});
}
