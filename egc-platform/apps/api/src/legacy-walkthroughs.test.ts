import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { LegacyWalkthroughError } from "@egc/operations";
import { registerLegacyWalkthroughRoutes } from "./legacy-walkthroughs.js";

const id = "f77cc10a-d4d6-4d19-a314-62b6763fb419";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup(enabled: boolean) {
  const app = Fastify(); apps.push(app); await app.register(multipart);
  const contactExists = vi.fn(async () => true), save = vi.fn(async () => ({id, status: "draft"})), approve = vi.fn(async () => ({ok: true, jobId: id}));
  await registerLegacyWalkthroughRoutes(app, async (request, reply) => { if (request.headers.authorization !== "Bearer isolated-internal-token") await reply.code(401).send({error: "unauthorized"}); }, {EGC_OPERATIONS_ENABLED: String(enabled)}, {contactExists, save, approve});
  return {app, contactExists, save, approve};
}
const auth = {authorization: "Bearer isolated-internal-token"};
const audio = {headers: {...auth, "content-type": "multipart/form-data; boundary=isolated"}, payload: "--isolated\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"walkthrough.webm\"\r\nContent-Type: audio/webm\r\n\r\nsynthetic-audio\r\n--isolated--\r\n"};
describe("legacy walkthrough compatibility boundary", () => {
  it("flag-off upload saves a draft and approval preserves the legacy response", async () => {
    const {app, save, approve} = await setup(false);
    const uploaded = await app.inject({method: "POST", url: `/walkthroughs/${id}/audio`, ...audio});
    expect(uploaded.statusCode).toBe(201); expect(uploaded.json().walkthrough.status).toBe("draft");
    expect(save).toHaveBeenCalledWith(id, Buffer.from("synthetic-audio"), "walkthrough.webm", "audio/webm");
    const approved = await app.inject({method: "POST", url: `/walkthroughs/${id}/approve`, headers: auth, payload: {extraction: {garageSize: "2_car"}, approvedBy: "forged-owner"}});
    expect(approved.statusCode).toBe(200); expect(approved.json()).toEqual({ok: true, jobId: id});
    expect(approve).toHaveBeenCalledWith(id, {garageSize: "2_car"});
  });
  it("flag-on blocks both routes before database, storage, AI or approval", async () => {
    const {app, contactExists, save, approve} = await setup(true);
    for (const route of ["audio", "approve"]) {
      const response = await app.inject({method: "POST", url: `/walkthroughs/${id}/${route}`, headers: auth, payload: {}});
      expect(response.statusCode).toBe(409); expect(response.json().error).toBe("use_employee_hub_recording_review");
    }
    expect(contactExists).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
  });
  it("flag-off still requires internal authentication", async () => {
    const {app, save, approve} = await setup(false);
    const response = await app.inject({method: "POST", url: `/walkthroughs/${id}/approve`, payload: {}});
    expect(response.statusCode).toBe(401); expect(save).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
  });
  it("managed-record rejection remains enforced during rollback", async () => {
    const {app, approve} = await setup(false); approve.mockRejectedValue(new LegacyWalkthroughError("use_employee_hub_recording_review"));
    const response = await app.inject({method: "POST", url: `/walkthroughs/${id}/approve`, headers: auth, payload: {}});
    expect(response.statusCode).toBe(409); expect(response.json().error).toBe("use_employee_hub_recording_review");
  });
  it("unknown contact and malformed IDs cannot reach storage; upstream errors are redacted", async () => {
    const {app, contactExists, save, approve} = await setup(false); contactExists.mockResolvedValue(false);
    expect((await app.inject({method: "POST", url: `/walkthroughs/${id}/audio`, ...audio})).statusCode).toBe(404);
    expect((await app.inject({method: "POST", url: "/walkthroughs/invalid/audio", ...audio})).statusCode).toBe(400); expect(save).not.toHaveBeenCalled();
    approve.mockRejectedValue(new Error("customer secret token=private"));
    const response = await app.inject({method: "POST", url: `/walkthroughs/${id}/approve`, headers: auth, payload: {}});
    expect(response.statusCode).toBe(503); expect(response.body).not.toMatch(/customer|secret|private/);
  });
});
