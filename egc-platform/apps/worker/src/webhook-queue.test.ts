import {it,expect} from "vitest";
import {webhookRetry} from "./webhook-queue.js";
it("backs off provider failures and stops at a visible dead letter",()=>{
  const now=new Date("2026-09-20T12:00:00Z");
  expect(webhookRetry(1,now)).toEqual({processingStatus:"pending",availableAt:new Date(now.valueOf()+30000)});
  expect(webhookRetry(4,now).processingStatus).toBe("pending");
  expect(webhookRetry(5,now).processingStatus).toBe("failed");
});
