import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Actions,
  DockLocation,
  Layout,
  Model,
  TabNode,
  type IJsonModel,
} from "flexlayout-react";
import "flexlayout-react/style/dark.css";

/**
 * The workspace: every panel is a tile, and the map is one of them.
 *
 * The rule that shapes this whole file is that MapLibre must NEVER be
 * unmounted. A GL map costs a context, a style parse, a tile fetch and every
 * bit of camera and filter state the session has built up; remounting it when a
 * tab is dragged or deselected would be a visible full reload. So the map div
 * is not inside the layout tree at all. The "Map" tab renders an empty,
 * transparent HOLE, reports its rectangle, and the one real map element — owned
 * by App, mounted once — is positioned to match.
 *
 * That is why the hole is `pointer-events: none` and why the tab it lives in is
 * transparent (see index.css): the map is genuinely underneath, and clicks,
 * drags and scroll wheels have to reach it.
 */

export type PanelId =
  | "map"
  | "timeline"
  | "layers"
  | "hierarchy"
  | "details"
  | "edit"
  | "studio";

export const PANELS: { id: PanelId; name: string }[] = [
  { id: "map", name: "Map" },
  { id: "timeline", name: "Timeline" },
  { id: "layers", name: "Layers" },
  { id: "hierarchy", name: "Hierarchy" },
  { id: "details", name: "Details" },
  { id: "edit", name: "Edit Tools" },
  { id: "studio", name: "Studio" },
];

const nameOf = (id: PanelId) => PANELS.find((p) => p.id === id)?.name ?? id;

const tab = (id: PanelId) => ({ type: "tab", id, name: nameOf(id), component: id });

/**
 * Where each panel lands when it is (re)opened from the Window menu. A panel
 * with no home would be dropped on whichever tabset happened to be first, which
 * is how the timeline ends up in the sidebar.
 */
const HOME: Record<PanelId, string> = {
  map: "centre",
  timeline: "bottom",
  layers: "side",
  hierarchy: "side",
  details: "side",
  edit: "side",
  studio: "side",
};

const DEFAULT_LAYOUT: IJsonModel = {
  global: {
    tabSetEnableMaximize: true,
    tabEnableRename: false,
    // A tabset that can be dragged to zero is a panel the user has lost.
    tabSetMinWidth: 140,
    tabSetMinHeight: 60,
  },
  borders: [],
  // FlexLayout has no "column": nested rows alternate orientation, so the outer
  // row splits left/right and the inner one splits top/bottom. Naming it
  // "column" silently drops the whole branch — the map and the timeline simply
  // did not exist.
  layout: {
    type: "row",
    children: [
      {
        type: "row",
        weight: 74,
        children: [
          { type: "tabset", id: "centre", weight: 78, children: [tab("map")] },
          { type: "tabset", id: "bottom", weight: 22, children: [tab("timeline")] },
        ],
      },
      {
        type: "tabset",
        id: "side",
        weight: 26,
        children: [tab("hierarchy"), tab("details"), tab("layers")],
      },
    ],
  },
};

const STORE = "layout:v1";

export type Dock = ReturnType<typeof useDock>;

/**
 * The layout model and the two operations the Window menu needs.
 *
 * The saved layout is a few kilobytes of JSON and is read synchronously at
 * first paint, so it stays in localStorage — unlike the edit and annotation
 * documents, it has no way to grow (see store.ts).
 */
export function useDock() {
  const [model, setModel] = useState<Model>(() => {
    try {
      const saved = localStorage.getItem(STORE);
      if (saved) return Model.fromJson(JSON.parse(saved));
    } catch (e) {
      // A layout saved by an older build must not be a white screen.
      console.warn("could not restore the layout", e);
    }
    return Model.fromJson(DEFAULT_LAYOUT);
  });
  const [open, setOpen] = useState<PanelId[]>([]);

  // Recomputed from the model rather than tracked alongside it, so a tab the
  // user closes with its own ✕ unticks itself in the menu too.
  const sync = useCallback((m: Model) => {
    setOpen(PANELS.filter((p) => !!m.getNodeById(p.id)).map((p) => p.id));
  }, []);

  useEffect(() => sync(model), [model, sync]);

  const save = useCallback((m: Model) => {
    sync(m);
    try {
      localStorage.setItem(STORE, JSON.stringify(m.toJson()));
    } catch {
      /* a layout that fails to save is not worth interrupting anyone over */
    }
  }, [sync]);

  const isOpen = useCallback((id: PanelId) => open.includes(id), [open]);

  const show = useCallback(
    (id: PanelId) => {
      const node = model.getNodeById(id);
      if (node) return model.doAction(Actions.selectTab(id)); // already there: reveal it
      // Fall back to the first tabset when the panel's home has itself been
      // closed — otherwise reopening Details after closing the sidebar throws.
      const home = model.getNodeById(HOME[id]) ? HOME[id] : firstTabsetId(model);
      if (home) model.doAction(Actions.addNode(tab(id), home, DockLocation.CENTER, -1));
    },
    [model],
  );

  const hide = useCallback(
    (id: PanelId) => {
      if (model.getNodeById(id)) model.doAction(Actions.deleteTab(id));
    },
    [model],
  );

  const toggle = useCallback(
    (id: PanelId) => (model.getNodeById(id) ? hide(id) : show(id)),
    [model, show, hide],
  );

  const reset = useCallback(() => {
    localStorage.removeItem(STORE);
    setModel(Model.fromJson(DEFAULT_LAYOUT));
  }, []);

  return { model, open, isOpen, show, hide, toggle, reset, save };
}

function firstTabsetId(model: Model): string | undefined {
  let found: string | undefined;
  model.visitNodes((n) => {
    if (!found && n.getType() === "tabset") found = n.getId();
  });
  return found;
}

export type Rect = { left: number; top: number; width: number; height: number };

export default function DockLayout({
  dock,
  render,
  onMapRect,
}: {
  dock: Dock;
  /** Panel content, by id. Owned by App — this file knows nothing about them. */
  render: (id: PanelId) => ReactNode;
  /** The Map tab's box, in page coordinates. null when it is not on screen. */
  onMapRect: (r: Rect | null) => void;
}) {
  const factory = (node: TabNode) => {
    const id = node.getComponent() as PanelId;
    return id === "map" ? <MapHole onRect={onMapRect} /> : render(id);
  };

  return (
    <Layout
      model={dock.model}
      factory={factory}
      onModelChange={(m) => {
        dock.save(m);
        // Dragging the Map tab to a tabset of the SAME size moves it without
        // resizing it, and a ResizeObserver never fires. One nudge after the
        // layout settles covers those; the observer covers everything else.
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      }}
      // Redraw while the splitter is still moving, so the map tracks the drag
      // instead of jumping into place when the mouse is released.
      realtimeResize
    />
  );
}

/**
 * The Map tab's stand-in. Renders nothing and reports where it is.
 *
 * ResizeObserver alone is not enough: dragging the tab to the other side of the
 * workspace can leave its SIZE identical and only change its POSITION, and the
 * map would stay behind on the old side. The window resize event that
 * `onRenderTabSet` fires above covers those, and unmounting reports null so the
 * map hides instead of floating over whatever took its place.
 */
function MapHole({ onRect }: { onRect: (r: Rect | null) => void }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const push = () => {
      const n = el.current;
      if (!n) return;
      const b = n.getBoundingClientRect();
      onRect({ left: b.left, top: b.top, width: b.width, height: b.height });
    };
    const ro = new ResizeObserver(push);
    ro.observe(el.current!);
    window.addEventListener("resize", push);
    push();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", push);
      onRect(null);
    };
  }, [onRect]);

  return <div ref={el} className="map-hole h-full w-full" />;
}
