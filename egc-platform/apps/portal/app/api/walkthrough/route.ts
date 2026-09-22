import {employeeHubUrl} from "../../../lib/format";
export const runtime = "nodejs";

/** Walkthrough writes must be associated with an authenticated Hub visit. */
export async function POST() {
  return Response.json({error:"use_employee_hub_recording_review",hubUrl:employeeHubUrl()},{status:409});
}
