import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliveryTab } from "../../src/components/project/DeliveryTab";

type Scenario = "owner" | "admin" | "viewer" | "nonmanager" | "cross-studio";

type FakeRequest = {
  method: string;
  path: string;
};

const scenario = (new URLSearchParams(window.location.search).get("scenario") || "owner") as Scenario;
const projectId = 131;
const fakeRequests: FakeRequest[] = [];
const harnessErrors: string[] = [];
let externalGuardVerified = false;

window.addEventListener("error", (event) => {
  harnessErrors.push(event.error instanceof Error ? event.error.message : event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  harnessErrors.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
});

const operationsByRole = {
  owner: {
    invitations: { pending: 2, sending: 1, sent: 8, failed: 3, needsReview: 1 },
    orderNotifications: { pending: 3, sending: 1, sent: 7, failed: 1, needsReview: 2 },
    issues: { invitations: 4, orderNotifications: 3 },
  },
  admin: {
    invitations: { pending: 4, sending: 2, sent: 6, failed: 1, needsReview: 2 },
    orderNotifications: { pending: 1, sending: 2, sent: 9, failed: 2, needsReview: 1 },
    issues: { invitations: 3, orderNotifications: 3 },
  },
} as const;

function notification(status: string, retryAllowed = false, sentAt: string | null = null) {
  return { status, sentAt, attempts: status === "sent" ? 1 : 2, retryAllowed };
}

function managerOrders() {
  return [
    {
      id: 101,
      publicReference: "ORD-FAILED",
      status: "pending",
      paymentMethod: "establishment",
      customerName: "Failed Customer",
      customerEmail: "failed.customer@example.test",
      fulfillmentStatus: "not_required",
      deliveryMethod: "digital",
      deliveryAddress: null,
      amountTotal: 1200,
      currency: "usd",
      createdAt: "2027-01-02T10:00:00.000Z",
      paidAt: null,
      notifications: {
        orderReceived: notification("failed", true),
        paymentConfirmed: notification("sent", false, "2027-01-02T10:01:00.000Z"),
      },
    },
    {
      id: 102,
      publicReference: "ORD-REVIEW",
      status: "paid",
      paymentMethod: "stripe",
      customerName: "Review Customer",
      customerEmail: "review.customer@example.test",
      fulfillmentStatus: "paid",
      deliveryMethod: "digital",
      deliveryAddress: null,
      amountTotal: 2400,
      currency: "usd",
      createdAt: "2027-01-03T10:00:00.000Z",
      paidAt: "2027-01-03T10:02:00.000Z",
      notifications: {
        orderReceived: notification("sent", false, "2027-01-03T10:01:00.000Z"),
        paymentConfirmed: notification("needs_review"),
      },
    },
    {
      id: 103,
      publicReference: "ORD-QUIET",
      status: "cancelled",
      paymentMethod: "bank_transfer",
      customerName: "Quiet Customer",
      customerEmail: "quiet.customer@example.test",
      fulfillmentStatus: "not_required",
      deliveryMethod: "digital",
      deliveryAddress: null,
      amountTotal: 500,
      currency: "usd",
      createdAt: "2027-01-04T10:00:00.000Z",
      paidAt: null,
      notifications: {
        orderReceived: notification("pending"),
        paymentConfirmed: notification("sending"),
      },
    },
  ];
}

function viewerOrders() {
  return [{
    ...managerOrders()[0],
    customerName: "Viewer Customer",
    customerEmail: "viewer-private-email@example.test",
    deliveryAddress: "Viewer private address",
    notifications: undefined,
    providerId: "provider-secret-must-not-render",
    snapshotEncrypted: "encrypted-snapshot-must-not-render",
    recoveryTokenHash: "recovery-hash-must-not-render",
  }];
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installLocalOnlyFakeApi() {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== window.location.origin) {
      throw new Error(`External network is forbidden in the browser harness: ${url.origin}`);
    }
    // Generated Orval URLs are currently slashless. Normalizing here keeps
    // the fake strict to API paths while making a harmless trailing slash
    // change visible in request diagnostics instead of breaking the gate.
    const path = url.pathname.replace(/\/+$/, "") || "/";
    fakeRequests.push({ method, path });

    if (!path.startsWith("/api/")) {
      throw new Error(`External network is forbidden in the browser harness: ${path}`);
    }

    if (scenario === "cross-studio" && (
      path === `/api/projects/${projectId}/delivery/orders`
      || path === `/api/projects/${projectId}/delivery/operations`
    )) {
      // The real project access guard intentionally uses a not-found
      // response so cross-studio membership cannot be enumerated.
      return jsonResponse({ error: "Project not found" }, 404);
    }

    if (path === "/api/studio") {
      const role = scenario === "owner" || scenario === "cross-studio"
        ? "owner"
        : scenario === "admin"
          ? "admin"
          : scenario === "viewer"
            ? "viewer"
            : "assistant";
      return jsonResponse({
        studio: {
          name: "Harness Studio",
          tagline: "Deterministic local test studio",
          contactEmail: "studio@example.test",
          logoObjectPath: null,
          primaryColor: "#0F766E",
          accentColor: "#14B8A6",
          brandingUpdatedAt: "2027-01-01T00:00:00.000Z",
        },
        member: { role, status: "active" },
      });
    }

    if (path === `/api/projects/${projectId}/delivery`) {
      return jsonResponse({
        gallery: { id: 9001, slug: "harness-gallery", status: "published" },
        projectType: "school",
        subjectLabel: "Student",
        groupLabel: "Class",
        accessCount: 4,
      });
    }

    if (path === "/api/studio/delivery/price-sheets") {
      return jsonResponse([]);
    }

    if (path === `/api/projects/${projectId}/delivery/orders`) {
      const isManager = scenario === "owner" || scenario === "admin";
      return jsonResponse({ orders: isManager ? managerOrders() : viewerOrders() });
    }

    if (path === `/api/projects/${projectId}/delivery/operations`) {
      const role = scenario === "admin" ? "admin" : "owner";
      return jsonResponse(operationsByRole[role]);
    }

    if (path === `/api/projects/${projectId}/delivery/orders/101/notifications/retry` && method === "POST") {
      return jsonResponse({ claimed: 1, sent: 1, failed: 0, needsReview: 0, pending: 0 });
    }

    throw new Error(`Unexpected local fake API request: ${method} ${path}`);
  };
}

function text(selector: string) {
  return document.querySelector(selector)?.textContent?.trim() || "";
}

function has(selector: string) {
  return Boolean(document.querySelector(selector));
}

function clickOrdersTab() {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === "Orders");
  button?.click();
}

function expectedSummary(role: "owner" | "admin") {
  const summary = operationsByRole[role];
  return [
    ["pending", summary.invitations.pending, summary.orderNotifications.pending],
    ["sending", summary.invitations.sending, summary.orderNotifications.sending],
    ["sent", summary.invitations.sent, summary.orderNotifications.sent],
    ["failed", summary.invitations.failed, summary.orderNotifications.failed],
    ["needsReview", summary.invitations.needsReview, summary.orderNotifications.needsReview],
  ] as const;
}

function runAssertions(): { pass: boolean; scenario: Scenario; failures: string[] } {
  const failures: string[] = [];
  const bodyText = document.body.textContent || "";
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };

  if (scenario === "owner" || scenario === "admin") {
    for (const [state, invitations, orders] of expectedSummary(scenario)) {
      check(text(`[data-testid="text-delivery-operations-invitations-${state}"]`) === String(invitations), `${scenario}: invitation count for ${state}`);
      check(text(`[data-testid="text-delivery-operations-orders-${state}"]`) === String(orders), `${scenario}: order notification count for ${state}`);
    }
    check(text('[data-testid="status-notification-order_received-101"]') === "Failed", `${scenario}: failed order_received state`);
    check(text('[data-testid="status-notification-payment_confirmed-101"]').startsWith("Sent"), `${scenario}: sent payment_confirmed state`);
    check(text('[data-testid="status-notification-payment_confirmed-102"]') === "Needs review", `${scenario}: needs_review payment_confirmed state`);
    check(text('[data-testid="status-notification-order_received-103"]') === "Queued", `${scenario}: pending order_received state`);
    check(text('[data-testid="status-notification-payment_confirmed-103"]') === "Sending", `${scenario}: sending payment_confirmed state`);
    check(has('[data-testid="button-retry-order-notifications-101"]'), `${scenario}: failed-only retry is available`);
    check(!has('[data-testid="button-retry-order-notifications-102"]'), `${scenario}: needs_review has no retry`);
    check(has('[data-testid="warning-notification-review-102"]'), `${scenario}: needs_review warning is visible`);
    check(!has('[data-testid="button-retry-order-notifications-103"]'), `${scenario}: non-failed state has no retry`);

    check(fakeRequests.some((request) => request.method === "POST" && request.path.endsWith("/orders/101/notifications/retry")), `${scenario}: retry uses local fake only`);
  } else if (scenario === "viewer" || scenario === "nonmanager") {
    check(!has('[data-testid="summary-delivery-operations"]'), `${scenario}: operational summary is hidden`);
    check(!has('[data-testid="status-notification-order_received-101"]'), `${scenario}: notification states are hidden`);
    check(!has('[data-testid="button-retry-order-notifications-101"]'), `${scenario}: retry action is hidden`);
    check(!has('[data-testid="select-order-payment-101"]'), `${scenario}: payment controls are hidden`);
    check(!has('[data-testid="select-order-fulfillment-101"]'), `${scenario}: fulfillment controls are hidden`);
    check(!bodyText.includes("provider-secret-must-not-render"), `${scenario}: provider identifier is absent from the DOM`);
    check(!bodyText.includes("encrypted-snapshot-must-not-render"), `${scenario}: encrypted snapshot is absent from the DOM`);
    check(!bodyText.includes("recovery-hash-must-not-render"), `${scenario}: recovery hash is absent from the DOM`);
  } else {
    check(has('[data-testid="alert-orders-error"]'), "cross-studio: order details are unavailable");
    check(!has('[data-testid="summary-delivery-operations"]'), "cross-studio: operational summary is unavailable");
    check(!bodyText.includes("customer@example.test"), "cross-studio: customer data is absent from the DOM");
  }

  const result: {
    pass: boolean;
    scenario: Scenario;
    failures: string[];
    debug?: {
      requests: FakeRequest[];
      errors: string[];
      activeTab: string;
      testIds: string[];
    };
  } = { pass: failures.length === 0, scenario, failures };
  if (failures.length > 0) {
    result.debug = {
      requests: [...fakeRequests],
      errors: [...harnessErrors],
      activeTab: document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim() || "",
      testIds: Array.from(document.querySelectorAll("[data-testid]"))
        .map((element) => element.getAttribute("data-testid"))
        .filter((value): value is string => Boolean(value)),
    };
  }
  return result;
}

function publishResult(result: { pass: boolean; scenario: Scenario; failures: string[] }) {
  const output = document.createElement("pre");
  output.id = "harness-result";
  output.textContent = JSON.stringify(result);
  document.body.append(output);
}

function Harness() {
  const finished = useRef(false);
  const clickedRetry = useRef(false);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (finished.current) return;
      const ready = externalGuardVerified && (scenario === "cross-studio"
        ? has('[data-testid="alert-orders-error"]')
        : has('[data-testid="row-order-101"]')
          && (scenario === "owner" || scenario === "admin"
            ? has('[data-testid="summary-delivery-operations"]')
            : true));
      if (ready && (scenario === "owner" || scenario === "admin")) {
        const retried = fakeRequests.some((request) =>
          request.method === "POST" && request.path.endsWith("/orders/101/notifications/retry"));
        if (!clickedRetry.current) {
          clickedRetry.current = true;
          (document.querySelector('[data-testid="button-retry-order-notifications-101"]') as HTMLButtonElement | null)?.click();
          return;
        }
        if (!retried && Date.now() - startedAt <= 4000) return;
      }
      if (ready || Date.now() - startedAt > 4000) {
        finished.current = true;
        window.clearInterval(timer);
        publishResult(runAssertions());
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, []);

  return <DeliveryTab projectId={projectId} projectName="Harness Project" initialTab="orders" />;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0 } },
});

// Install before React effects run so every generated hook request is local.
installLocalOnlyFakeApi();
void window.fetch("https://api.stripe.com/v1/checkout/sessions")
  .then(() => {
    harnessErrors.push("External network guard unexpectedly allowed a Stripe request");
  })
  .catch(() => {
    externalGuardVerified = true;
  });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Harness />
  </QueryClientProvider>,
);
