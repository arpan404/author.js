import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Decision } from "../index";
import { AuthorProvider, Can, Cannot, useCan } from "../packages/react/src/index";

const allowedDecision: Decision = {
  allowed: true,
  effect: "allow",
  reason: "ok",
  action: "read",
  entity: { type: "User", id: "u1" },
  resource: { type: "Project", id: "p1" },
  matchedPolicies: [],
  skippedPolicies: [],
  metadata: { evaluatedAt: new Date(), mode: "frontend", durationMs: 0 },
};
const deniedDecision = { ...allowedDecision, allowed: false, effect: "deny", reason: "no" } satisfies Decision;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container = null;
});

describe("react adapter", () => {
  test("Can renders children when allowed and fallback when denied", async () => {
    setupDom();
    const author = { evaluate: async () => allowedDecision };

    await render(
      <AuthorProvider entityType="User" authorization={author} entity={{ id: "u1" }}>
        <Can do="read" on="Project" resource={{ id: "p1" }} fallback={<span>denied</span>}>
          <span>allowed</span>
        </Can>
      </AuthorProvider>,
    );

    expect(container?.textContent).toBe("allowed");

    await render(
      <AuthorProvider entityType="User" authorization={{ evaluate: async () => deniedDecision }} entity={{ id: "u1" }}>
        <Can do="read" on="Project" resource={{ id: "p1" }} fallback={<span>denied</span>}>
          <span>allowed</span>
        </Can>
      </AuthorProvider>,
    );

    expect(container?.textContent).toBe("denied");
  });

  test("Cannot renders children when denied", async () => {
    setupDom();

    await render(
      <AuthorProvider entityType="User" authorization={{ evaluate: async () => deniedDecision }} entity={{ id: "u1" }}>
        <Cannot do="delete" on="Project" resource={{ id: "p1" }}>
          <span>cannot</span>
        </Cannot>
      </AuthorProvider>,
    );

    expect(container?.textContent).toBe("cannot");
  });

  test("provider context is passed and per-check context overrides it", async () => {
    setupDom();
    const seen: unknown[] = [];

    await render(
      <AuthorProvider
        entityType="User"
        authorization={{
          evaluate: async (input) => {
            seen.push(input.context);
            return allowedDecision;
          },
        }}
        entity={{ id: "u1" }}
        context={{ tenantId: "tenant_1", source: "provider" }}
      >
        <Can do="read" on="Project" resource={{ id: "p1" }} context={{ source: "component" }}>
          <span>allowed</span>
        </Can>
      </AuthorProvider>,
    );

    expect(seen.at(-1)).toEqual({ tenantId: "tenant_1", source: "component" });
  });

  test("useCan exposes loading and decision state", async () => {
    setupDom();
    const states: Array<{ loading: boolean; allowed: boolean; reason: string | null }> = [];
    function Probe() {
      const result = useCan({ do: "read", on: "Project", resource: { id: "p1" } });
      states.push({ loading: result.loading, allowed: result.allowed, reason: result.decision?.reason ?? null });
      return null;
    }

    await render(
      <AuthorProvider entityType="User" authorization={{ evaluate: async () => allowedDecision }} entity={{ id: "u1" }}>
        <Probe />
      </AuthorProvider>,
    );

    expect(states[0]).toEqual({ loading: true, allowed: false, reason: null });
    expect(states.at(-1)).toEqual({ loading: false, allowed: true, reason: "ok" });
  });

  test("duplicate checks under one provider share a decision", async () => {
    setupDom();
    let calls = 0;
    const author = {
      evaluate: async () => {
        calls += 1;
        return allowedDecision;
      },
    };

    await render(
      <AuthorProvider entityType="User" authorization={author} entity={{ id: "u1" }}>
        <Can do="read" on="Project" resource={{ id: "p1" }}>
          <span>a</span>
        </Can>
        <Can do="read" on="Project" resource={{ id: "p1" }}>
          <span>b</span>
        </Can>
      </AuthorProvider>,
    );

    expect(container?.textContent).toBe("ab");
    expect(calls).toBe(1);
  });
});

function setupDom(): void {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const window = new Window();
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true });
  const div = document.createElement("div");
  document.body.append(div);
  container = div;
  root = createRoot(div);
}

async function render(element: ReactNode): Promise<void> {
  await act(async () => {
    root?.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
}
