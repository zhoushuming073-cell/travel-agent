import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => readFileSync(path.join(projectRoot, relativePath), "utf8");
const lineCount = (source: string) => source.split(/\r?\n/).length;

test("travel styles stay layered and small enough to review safely", () => {
  const manifestPath = "app/travel/[[...tripId]]/workspace-react.css";
  const styleDirectory = path.join(projectRoot, "app/travel/[[...tripId]]/styles");
  const manifest = read(manifestPath);
  const modules = readdirSync(styleDirectory).filter((name) => name.endsWith(".css"));

  assert.ok(modules.length >= 12, "travel styles should remain split by responsibility");
  assert.ok(statSync(path.join(projectRoot, manifestPath)).size < 4_000, "the stylesheet entry should only orchestrate modules");
  assert.match(manifest, /@import "\.\/styles\/tokens\.css";/);
  assert.match(manifest, /@import "\.\/styles\/dashboard\.css";/);
  assert.match(manifest, /@import "\.\/styles\/acquisition\.css";/);

  for (const moduleName of modules) {
    assert.ok(
      statSync(path.join(styleDirectory, moduleName)).size < 40_000,
      `${moduleName} is too large and should be split before adding more rules`,
    );
  }

  assert.equal(existsSync(path.join(projectRoot, "public/travel/styles.css")), false, "the obsolete duplicate stylesheet must not return");
});

test("travel workspace and ready dashboard remain composition roots", () => {
  const app = read("travel/TravelWorkspaceApp.tsx");
  const dashboard = read("travel/components/ReadyDashboard.tsx");

  assert.ok(lineCount(app) <= 430, "TravelWorkspaceApp should orchestrate hooks and views instead of accumulating workflows");
  assert.match(app, /usePlanningLifecycle/);
  assert.match(app, /usePlanningProgress/);
  assert.match(app, /from "\.\/state\/workspace-config\.ts"/);

  assert.ok(lineCount(dashboard) <= 100, "ReadyDashboard should compose feature regions instead of implementing every panel");
  for (const feature of ["TripOverview", "DecisionPanel", "DiscoverPanel", "PlanningInsights"]) {
    assert.match(dashboard, new RegExp(feature));
  }
});

test("confirmed legacy travel selectors do not return", () => {
  const styleDirectory = path.join(projectRoot, "app/travel/[[...tripId]]/styles");
  const styles = readdirSync(styleDirectory)
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(path.join(styleDirectory, name), "utf8"))
    .join("\n");

  const retiredSelectors = [
    "assistant-intro",
    "conversation-rail",
    "react-source-grid",
    "react-data-lower",
    "candidate-skeletons",
    "live-discovery-card",
    "agent-live-log",
    "evidence-meter",
    "data-truth-grid",
    "loading-files-motion",
    "react-profile-visual",
    "profile-detail-grid",
  ];

  for (const selector of retiredSelectors) {
    assert.equal(styles.includes(`.${selector}`), false, `${selector} was retired and must not be styled again`);
  }
});

test("workspace navigation stays user-controlled during review and background planning", () => {
  const app = read("travel/TravelWorkspaceApp.tsx");
  const lifecycle = read("travel/hooks/usePlanningLifecycle.ts");
  const sidebarStyles = read("app/travel/[[...tripId]]/styles/layout.css");

  assert.doesNotMatch(app, /reviewStep === 0\)\) setSidebarCollapsed\(false\)/, "stage review must not force the sidebar open");
  assert.doesNotMatch(app, />旅行参数<\/button>/, "the ambiguous header parameter action must stay removed");
  assert.match(app, /if \(planningControllerRef\.current\) await persist\(\)/, "opening history should preserve the running workspace without cancelling it");
  assert.doesNotMatch(app, /openWorkspace[\s\S]{0,240}cancelPlanning\(\)/, "opening history must not cancel the active planning job");
  assert.match(app, /getStoredPlanningWorkspaceId/, "a planning task must remain attached to its originating workspace");
  assert.doesNotMatch(lifecycle, /setTimeout\(\(\) => \{ void reconnectPlanning/, "planning recovery must not auto-take over a historical workspace");
  assert.match(sidebarStyles, /\.react-sidebar\.is-collapsed \.history-item\.active/, "the collapsed rail must retain a clear active-trip state");
});
