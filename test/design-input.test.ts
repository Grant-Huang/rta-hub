/**
 * 设计输入标准化导入导出（FR-24）：`provenance: "customer"` 直接采信免确认，
 * `assumed`（含未声明）仍走 Q# 确认门禁；导出把当前状态原样序列化回同一 schema。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.SENDER_NAME = "RTA Hub";
process.env.SMTP_FROM = "quotes@rta-hub.test";
process.env.SENDER_PHONE = "+1-800-555-0100";

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  const mod = await import("../src/server.js");
  app = await mod.createApp({ ephemeral: true, llm: undefined });
});

const CONSUMER = "ca_demo_consumer";
const base = "http://localhost";

function req(pathname: string, init: RequestInit & { accountId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.accountId) headers.set("x-account-id", init.accountId);
  return app.fetch(new Request(base + pathname, { ...init, headers }));
}

async function createConversation(accountId = CONSUMER): Promise<string> {
  const r = await req("/api/conversations", { method: "POST", accountId });
  assert.equal(r.status, 201);
  const body = await r.json() as { conversation: { id: string } };
  return body.conversation.id;
}

interface DesignInputResponse {
  floorPlan: {
    id: string;
    parsedGeometry: {
      wallRuns: { id: string; label: string; length: number; features: { id: string; kind: string }[] }[];
      ceilingHeight?: number;
    };
    unresolvedItems: { id: string; target: { kind: string; id?: string }; field: string; resolved: boolean }[];
    appliances?: { kind: string; width: number; provenance: string }[];
  };
  ready: boolean;
}

const fullyConfirmedDoc = {
  schemaVersion: "1.0",
  source: { kind: "vl_model", producer: "test-vl-extractor" },
  geometry: {
    wallRuns: [
      {
        label: "North", length: 144, provenance: "customer",
        features: [
          { kind: "window", offset: 48, width: 36, provenance: "customer" },
        ],
      },
      { label: "East", length: 96, provenance: "customer", features: [] },
    ],
    ceilingHeight: { value: 96, provenance: "customer" },
    confidence: 0.97,
  },
  appliances: [
    { kind: "refrigerator", width: 36, clearanceEachSide: 1, provenance: "customer" },
  ],
};

test("全 customer provenance 导入 → 无待确认项，直接 ready", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify(fullyConfirmedDoc),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const body = await r.json() as DesignInputResponse;

  assert.equal(body.floorPlan.parsedGeometry.wallRuns.length, 2);
  assert.equal(body.floorPlan.parsedGeometry.ceilingHeight, 96);
  const unresolved = body.floorPlan.unresolvedItems.filter((u) => !u.resolved);
  assert.equal(unresolved.length, 0, "customer provenance 不应产生待确认项");
  assert.equal(body.ready, true);
  assert.equal(body.floorPlan.appliances?.[0]?.provenance, "customer");
});

test("assumed / 未声明 provenance → 生成待确认项，未 ready", async () => {
  const id = await createConversation();
  const doc = {
    schemaVersion: "1.0",
    geometry: {
      wallRuns: [
        {
          label: "North", length: 144, provenance: "assumed",
          features: [
            { kind: "window", offset: 48, width: 36 }, // 未声明 provenance
          ],
        },
      ],
      ceilingHeight: { value: 96 }, // 未声明 provenance
    },
  };
  const r = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify(doc),
  });
  assert.equal(r.status, 201, await r.clone().text());
  const body = await r.json() as DesignInputResponse;

  const unresolved = body.floorPlan.unresolvedItems.filter((u) => !u.resolved);
  // 1 段墙 + 1 个窗 + 1 个层高 = 3 条待确认
  assert.equal(unresolved.length, 3);
  assert.ok(unresolved.some((u) => u.target.kind === "wallRun"));
  assert.ok(unresolved.some((u) => u.target.kind === "feature"));
  assert.ok(unresolved.some((u) => u.target.kind === "global" && u.field === "ceilingHeight"));
  assert.equal(body.ready, false);
});

test("混合 provenance → 只有 assumed 的那段墙留待确认", async () => {
  const id = await createConversation();
  const doc = {
    schemaVersion: "1.0",
    geometry: {
      wallRuns: [
        { label: "North", length: 144, provenance: "customer", features: [] },
        { label: "East", length: 96, provenance: "assumed", features: [] },
      ],
      ceilingHeight: { value: 96, provenance: "customer" },
    },
  };
  const r = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify(doc),
  });
  const body = await r.json() as DesignInputResponse;
  const unresolved = body.floorPlan.unresolvedItems.filter((u) => !u.resolved);
  assert.equal(unresolved.length, 1);
  const eastId = body.floorPlan.parsedGeometry.wallRuns.find((w) => w.label === "East")!.id;
  assert.equal(unresolved[0]!.target.id, eastId);
});

test("非法 schemaVersion → 400", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ schemaVersion: "9.9", geometry: { wallRuns: [] } }),
  });
  assert.equal(r.status, 400);
});

test("空 wallRuns → 400", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ schemaVersion: "1.0", geometry: { wallRuns: [] } }),
  });
  assert.equal(r.status, 400);
});

test("非法 provenance 值 → 400", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({
      schemaVersion: "1.0",
      geometry: { wallRuns: [{ label: "North", length: 144, provenance: "verified", features: [] }] },
    }),
  });
  assert.equal(r.status, 400);
});

test("导出：全 customer 导入后导出 provenance 全部回填为 customer", async () => {
  const id = await createConversation();
  const created = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify(fullyConfirmedDoc),
  });
  const createdBody = await created.json() as DesignInputResponse;

  const exported = await req(`/api/conversations/${id}/design-input`, { accountId: CONSUMER });
  assert.equal(exported.status, 200, await exported.clone().text());
  const exportedBody = await exported.json() as {
    designInput: {
      schemaVersion: string;
      geometry: { wallRuns: { label: string; provenance: string; features: { provenance: string }[] }[]; ceilingHeight?: { provenance: string } };
      appliances?: { provenance: string }[];
    };
  };
  assert.equal(exportedBody.designInput.schemaVersion, "1.0");
  for (const w of exportedBody.designInput.geometry.wallRuns) {
    assert.equal(w.provenance, "customer");
    for (const f of w.features) assert.equal(f.provenance, "customer");
  }
  assert.equal(exportedBody.designInput.geometry.ceilingHeight?.provenance, "customer");
  assert.equal(exportedBody.designInput.appliances?.[0]?.provenance, "customer");
  assert.equal(createdBody.ready, true);
});

test("导出：assumed 的一段墙确认后，导出结果变为 customer", async () => {
  const id = await createConversation();
  const doc = {
    schemaVersion: "1.0",
    geometry: {
      wallRuns: [{ label: "North", length: 144, provenance: "assumed", features: [] }],
      ceilingHeight: { value: 96, provenance: "customer" },
    },
  };
  const created = await req(`/api/conversations/${id}/design-input`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify(doc),
  });
  const createdBody = await created.json() as DesignInputResponse;

  const beforeExport = await req(`/api/conversations/${id}/design-input`, { accountId: CONSUMER });
  const beforeBody = await beforeExport.json() as {
    designInput: { geometry: { wallRuns: { provenance: string }[] } };
  };
  assert.equal(beforeBody.designInput.geometry.wallRuns[0]!.provenance, "assumed");

  const itemId = createdBody.floorPlan.unresolvedItems.find((u) => !u.resolved)!.id;
  const wallRunId = createdBody.floorPlan.parsedGeometry.wallRuns[0]!.id;
  const resolveRes = await req(`/api/floorplans/${createdBody.floorPlan.id}/resolve`, {
    method: "POST",
    accountId: CONSUMER,
    body: JSON.stringify({ itemId, wallRunId, length: 144 }),
  });
  assert.equal(resolveRes.status, 200, await resolveRes.clone().text());

  const afterExport = await req(`/api/conversations/${id}/design-input`, { accountId: CONSUMER });
  const afterBody = await afterExport.json() as {
    designInput: { geometry: { wallRuns: { provenance: string }[] } };
  };
  assert.equal(afterBody.designInput.geometry.wallRuns[0]!.provenance, "customer");
});

test("导出：还没有户型时 → 404", async () => {
  const id = await createConversation();
  const r = await req(`/api/conversations/${id}/design-input`, { accountId: CONSUMER });
  assert.equal(r.status, 404);
});
