"use client";

import { ChevronDownIcon, ChevronUpIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LOCALES, useLocale } from "@/lib/i18n/locale";
import {
  PANEL_WIDTH_RANGE,
  clampPanelWidth,
  usePanelOrder,
  type PanelId,
} from "@/lib/panel-order";
import {
  DEFAULT_SHELL_SETTINGS,
  getShellSettings,
  putShellSettings,
  type CloseAction,
} from "@/lib/shell-settings";
import { SettingsCard, SettingsError, SettingsHeader } from "./primitives";

const PANEL_LABELS: Record<PanelId, string> = {
  tree: "Files",
  preview: "Preview",
  chat: "Chat",
};

export function AppearancePanel({
  panelWidths,
  onPanelWidthChange,
}: {
  panelWidths?: { tree: number; chat: number };
  onPanelWidthChange?: (panel: "tree" | "chat", value: number) => void;
} = {}) {
  const { theme, setTheme } = useTheme();
  const [locale, setLocale] = useLocale();
  const [panelOrder, setPanelOrder] = usePanelOrder();

  const movePanel = useCallback((id: PanelId, direction: -1 | 1) => {
    setPanelOrder((current) => {
      const index = current.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, [setPanelOrder]);

  const options: { value: string; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
  ];

  const [closeAction, setCloseAction] = useState<CloseAction>(
    DEFAULT_SHELL_SETTINGS.closeAction,
  );
  const [notify, setNotify] = useState({
    onComplete: DEFAULT_SHELL_SETTINGS.notifyOnRunComplete,
    onlyWhenUnfocused: DEFAULT_SHELL_SETTINGS.notifyOnlyWhenUnfocused,
  });
  const [shellError, setShellError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getShellSettings()
      .then((settings) => {
        if (cancelled) return;
        setCloseAction(settings.closeAction);
        setNotify({
          onComplete: settings.notifyOnRunComplete,
          onlyWhenUnfocused: settings.notifyOnlyWhenUnfocused,
        });
      })
      .catch((error: Error) => {
        if (!cancelled) setShellError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickCloseAction = useCallback((next: CloseAction) => {
    // Optimistic: the click should not feel laggy, and a failure reverts.
    const previous = closeAction;
    setCloseAction(next);
    setShellError(null);
    putShellSettings({ closeAction: next }).catch((error: Error) => {
      setCloseAction(previous);
      setShellError(error.message);
    });
  }, [closeAction]);

  const pickNotify = useCallback(
    (patch: { onComplete?: boolean; onlyWhenUnfocused?: boolean }) => {
      const previous = notify;
      const next = {
        onComplete: patch.onComplete ?? notify.onComplete,
        onlyWhenUnfocused: patch.onlyWhenUnfocused ?? notify.onlyWhenUnfocused,
      };
      setNotify(next);
      setShellError(null);
      putShellSettings({
        notifyOnRunComplete: next.onComplete,
        notifyOnlyWhenUnfocused: next.onlyWhenUnfocused,
      }).catch((error: Error) => {
        setNotify(previous);
        setShellError(error.message);
      });
    },
    [notify],
  );

  const closeOptions: { value: CloseAction; label: string; hint: string }[] = [
    {
      value: "tray",
      label: "Keep running in the tray",
      hint: "Closing the window frees the interface but keeps local services and scheduled work running.",
    },
    {
      value: "quit",
      label: "Quit the app",
      hint: "Closing the window stops everything, including running jobs.",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SettingsHeader
          title="Language"
          description="Switches the interface language. Saved in this browser."
          appliesTo="immediately"
        />
        <div className="flex gap-2">
          {LOCALES.map((option) => {
            const active = locale === option.id;
            return (
              <Button
                key={option.id}
                variant={active ? "default" : "outline"}
                size="sm"
                aria-pressed={active}
                onClick={() => setLocale(option.id)}
                className="flex-1 gap-1.5 text-xs"
              >
                {option.native}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <SettingsHeader
          title="Appearance"
          description="Choose how K-Dense BYOK looks. System follows your operating system's theme. Saved in this browser."
        />

        <div className="flex gap-2">
          {options.map((opt) => {
            const Icon = opt.icon;
            const active = theme === opt.value;
            return (
              <Button
                key={opt.value}
                variant={active ? "default" : "outline"}
                size="sm"
                aria-pressed={active}
                onClick={() => setTheme(opt.value)}
                className={cn("flex-1 gap-1.5 text-xs")}
              >
                <Icon className="size-3.5" />
                {opt.label}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SettingsHeader
          title="Closing the window"
          description="The app runs local services in the background. Choose what closing the window does."
          appliesTo="immediately"
        />
        <div className="flex flex-col gap-2">
          {closeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => pickCloseAction(opt.value)}
              aria-pressed={closeAction === opt.value}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left transition-colors",
                closeAction === opt.value
                  ? "border-border bg-muted/60"
                  : "border-transparent hover:border-border hover:bg-muted/30",
              )}
            >
              <div className="text-xs font-medium text-foreground">{opt.label}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {opt.hint}
              </div>
            </button>
          ))}
        </div>
        {shellError ? <SettingsError>{shellError}</SettingsError> : null}
      </div>

      <div className="flex flex-col gap-3">
        <SettingsHeader
          title="Finished runs"
          description="A long run can finish while you are working elsewhere. A system notification tells you it is ready."
          appliesTo="immediately"
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => pickNotify({ onComplete: !notify.onComplete })}
            aria-pressed={notify.onComplete}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-left transition-colors",
              notify.onComplete
                ? "border-border bg-muted/60"
                : "border-transparent hover:border-border hover:bg-muted/30",
            )}
          >
            <div className="text-xs font-medium text-foreground">
              Notify me when a chat finishes
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Uses the operating system&apos;s notifications. Nothing is sent
              anywhere — the app raises them locally.
            </div>
          </button>
          {notify.onComplete ? (
            <button
              type="button"
              onClick={() => pickNotify({ onlyWhenUnfocused: !notify.onlyWhenUnfocused })}
              aria-pressed={notify.onlyWhenUnfocused}
              className={cn(
                "ml-4 rounded-lg border px-3 py-2.5 text-left transition-colors",
                notify.onlyWhenUnfocused
                  ? "border-border bg-muted/60"
                  : "border-transparent hover:border-border hover:bg-muted/30",
              )}
            >
              <div className="text-xs font-medium text-foreground">
                Only when Kady is in the background
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                A notification for the chat already on screen is usually noise.
              </div>
            </button>
          ) : null}
        </div>
        {shellError ? <SettingsError>{shellError}</SettingsError> : null}
      </div>

      <SettingsCard
        id="panel-order"
        title="Panel order"
        description="Left to right on wide windows. The side panels can also be swapped by clicking the ends of the divider between them. On narrow windows the layout stays fixed."
      >
        <ol className="flex flex-col gap-1">
          {panelOrder.map((id, index) => (
            <li key={id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <span className="flex-1 text-xs font-medium text-foreground">{PANEL_LABELS[id]}</span>
              <Button
                variant="outline"
                size="sm"
                className="size-7 p-0"
                aria-label={`Move ${PANEL_LABELS[id]} left`}
                title={`Move ${PANEL_LABELS[id]} left`}
                disabled={index === 0}
                onClick={() => movePanel(id, -1)}
              >
                <ChevronUpIcon className="size-3.5 rotate-[-90deg]" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="size-7 p-0"
                aria-label={`Move ${PANEL_LABELS[id]} right`}
                title={`Move ${PANEL_LABELS[id]} right`}
                disabled={index === panelOrder.length - 1}
                onClick={() => movePanel(id, 1)}
              >
                <ChevronDownIcon className="size-3.5 rotate-[-90deg]" />
              </Button>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          The preview always takes the leftover width, so it stays the widest
          pane wherever it sits.
        </p>
      </SettingsCard>

      {panelWidths && onPanelWidthChange ? (
        <SettingsCard
          id="panel-widths"
          title="Panel widths"
          description="Saved per project. A boundary between two fixed-width panels cannot be dragged — the preview has to be on one side of it — so set those widths here."
        >
          <div className="flex flex-col gap-2">
            {(["tree", "chat"] as const).map((panel) => {
              const range = PANEL_WIDTH_RANGE[panel];
              return (
                <label key={panel} className="flex items-center gap-3 text-xs">
                  <span className="w-16 shrink-0 text-muted-foreground">{PANEL_LABELS[panel]}</span>
                  <input
                    type="number"
                    className="w-24 rounded border bg-background px-2 py-1 tabular-nums"
                    min={range.min}
                    max={range.max}
                    step={10}
                    value={panelWidths[panel]}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isFinite(value)) {
                        onPanelWidthChange(panel, clampPanelWidth(panel, value));
                      }
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {range.min}–{range.max} px
                  </span>
                </label>
              );
            })}
          </div>
        </SettingsCard>
      ) : null}
    </div>
  );
}
