/**
 * Page templates: good layouts the model adapts (titles, variables) instead of
 * starting from an empty grid. Variables are placeholders under 'PRG.'.
 */
import type { ScreenInput } from "./spec.js";

type Template = ScreenInput;

export const TEMPLATES: Record<string, { use: string; screen: Template }> = {
  overview: {
    use: "Plant overview: the process diagram large on the left, key values and status on the right, controls and a trend along the bottom.",
    screen: {
      name: "Overview",
      title: "Plant overview",
      subtitle: "Line A",
      widgets: [
        {
          type: "process",
          title: "Process",
          at: [1, 1, 8, 5],
          items: [
            { type: "tank", x: 20, y: 15, w: 18, h: 70, level: "PRG.rLevel", max: 100, unit: "%", label: "T-101" },
            { type: "pump", x: 58, y: 74.5, size: 11, running: "PRG.xPumpRunning", label: "P-101", faceplate: { auto: "PRG.xAuto", start: "PRG.xStart", stop: "PRG.xStop" } },
            { type: "valve", x: 82, y: 45, size: 7, open: "PRG.xValveOpen", vertical: true, label: "V-102" },
            { type: "pipe", from: [3, 74.5], to: "T-101.left", flow: "PRG.xInflow" },
            { type: "pipe", from: "T-101.right", to: "P-101.in", flow: "PRG.xPumpRunning" },
            { type: "pipe", from: "P-101.out", to: "V-102.in", flow: "PRG.xPumpRunning" },
            { type: "pipe", from: "V-102.out", to: [97, 15], flow: "PRG.xPumpRunning" },
            { type: "sensor", x: 89, y: 8, value: "PRG.rFlow", unit: "m³/h", label: "FT-103" },
          ],
        },
        { type: "gauge", title: "Level", at: [9, 1, 4, 3], value: "PRG.rLevel", min: 0, max: 100, unit: "%", bands: [{ from: 0, tone: "accent" }, { from: 85, tone: "warn" }, { from: 95, tone: "alarm" }] },
        { type: "status", title: "Status", at: [9, 4, 2, 2], items: [{ label: "Pump running", on: "PRG.xPumpRunning" }, { label: "Auto", on: "PRG.xAuto", tone: "accent" }, { label: "Fault", on: "PRG.xFault", tone: "alarm" }] },
        { type: "value", title: "Flow", at: [11, 4, 2, 2], value: "PRG.rFlow", unit: "m³/h", decimals: 1, trend: true },
        { type: "trend", title: "Level and flow", at: [1, 6, 5, 3], series: [{ value: "PRG.rLevel", label: "Level %" }, { value: "PRG.rFlow", label: "Flow m³/h" }], seconds: 120 },
        { type: "buttons", title: "Pump", at: [6, 6, 3, 2], items: [{ label: "Start", variable: "PRG.xStart", tone: "ok" }, { label: "Stop", variable: "PRG.xStop" }] },
        { type: "switch", title: "Mode", at: [6, 8, 3, 1], variable: "PRG.xAuto", label: "Automatic" },
        { type: "setpoint", title: "Level setpoint", at: [9, 6, 2, 3], variable: "PRG.rSetpoint", min: 0, max: 100, step: 0.5, unit: "%" },
        { type: "alarms", title: "Alarms", at: [11, 6, 2, 3], items: [{ active: "PRG.xHighLevel", text: "High level T-101", severity: "warning" }, { active: "PRG.xFault", text: "Pump P-101 fault" }] },
      ],
    },
  },
  unit: {
    use: "One machine or unit in detail: its diagram, every measured value, its controls.",
    screen: {
      name: "Unit",
      title: "Pump P-101",
      widgets: [
        { type: "process", title: "P-101", at: [1, 1, 6, 6], items: [{ type: "pump", x: 50, y: 50, size: 22, running: "PRG.xPumpRunning", fault: "PRG.xFault", label: "P-101" }, { type: "pipe", from: [3, 50], to: "P-101.in", flow: "PRG.xPumpRunning" }, { type: "pipe", from: "P-101.out", to: [97, 50], flow: "PRG.xPumpRunning" }] },
        { type: "value", title: "Speed", at: [7, 1, 3, 2], value: "PRG.rSpeed", unit: "rpm", decimals: 0, trend: true },
        { type: "value", title: "Current", at: [10, 1, 3, 2], value: "PRG.rCurrent", unit: "A", decimals: 1, trend: true },
        { type: "gauge", title: "Motor temperature", at: [7, 3, 3, 4], value: "PRG.rTemp", min: 0, max: 120, unit: "°C", bands: [{ from: 0, tone: "ok" }, { from: 80, tone: "warn" }, { from: 100, tone: "alarm" }] },
        { type: "status", title: "Status", at: [10, 3, 3, 4], items: [{ label: "Running", on: "PRG.xPumpRunning" }, { label: "Ready", on: "PRG.xReady" }, { label: "Auto", on: "PRG.xAuto", tone: "accent" }, { label: "Fault", on: "PRG.xFault", tone: "alarm" }] },
        { type: "buttons", title: "Control", at: [1, 7, 6, 2], items: [{ label: "Start", variable: "PRG.xStart", tone: "ok" }, { label: "Stop", variable: "PRG.xStop" }, { label: "Reset", variable: "PRG.xReset", tone: "warn" }] },
        { type: "setpoint", title: "Speed setpoint", at: [7, 7, 6, 2], variable: "PRG.rSpeedSet", min: 0, max: 1500, step: 10, unit: "rpm" },
      ],
    },
  },
  alarms: {
    use: "Alarm page: the active alarms large, the signals behind them, and test or reset buttons.",
    screen: {
      name: "Alarms",
      title: "Alarms",
      widgets: [
        { type: "alarms", title: "Active alarms", at: [1, 1, 8, 8], items: [{ active: "PRG.xHighLevel", text: "High level T-101", severity: "warning" }, { active: "PRG.xFault", text: "Pump P-101 fault" }, { active: "PRG.xLowPressure", text: "Low inlet pressure", severity: "warning" }] },
        { type: "status", title: "Signals", at: [9, 1, 4, 5], items: [{ label: "High level", on: "PRG.xHighLevel", tone: "warn" }, { label: "Pump fault", on: "PRG.xFault", tone: "alarm" }, { label: "Low pressure", on: "PRG.xLowPressure", tone: "warn" }] },
        { type: "buttons", title: "Alarms", at: [9, 6, 4, 3], items: [{ label: "Reset", variable: "PRG.xReset", tone: "warn" }] },
      ],
    },
  },
  trends: {
    use: "Trend page: one large chart and the current values beside it.",
    screen: {
      name: "Trends",
      title: "Trends",
      widgets: [
        { type: "trend", title: "Process values", at: [1, 1, 9, 8], series: [{ value: "PRG.rLevel", label: "Level %" }, { value: "PRG.rFlow", label: "Flow m³/h" }], seconds: 300 },
        { type: "value", title: "Level", at: [10, 1, 3, 3], value: "PRG.rLevel", unit: "%", decimals: 1, trend: true },
        { type: "value", title: "Flow", at: [10, 4, 3, 3], value: "PRG.rFlow", unit: "m³/h", decimals: 1, trend: true },
        { type: "text", title: "Note", at: [10, 7, 3, 2], text: "History starts when the page opens." },
      ],
    },
  },
  settings: {
    use: "Settings page: setpoints, limits and modes the operator may change.",
    screen: {
      name: "Settings",
      title: "Settings",
      widgets: [
        { type: "setpoint", title: "Level setpoint", at: [1, 1, 4, 3], variable: "PRG.rSetpoint", min: 0, max: 100, step: 0.5, unit: "%" },
        { type: "setpoint", title: "High level limit", at: [5, 1, 4, 3], variable: "PRG.rHighLimit", min: 50, max: 100, step: 1, unit: "%" },
        { type: "setpoint", title: "Pump start delay", at: [9, 1, 4, 3], variable: "PRG.rStartDelay", min: 0, max: 60, step: 1, unit: "s" },
        { type: "switch", title: "Mode", at: [1, 4, 4, 1], variable: "PRG.xAuto", label: "Automatic" },
        { type: "switch", title: "Alarm horn", at: [5, 4, 4, 1], variable: "PRG.xHornEnabled", label: "Horn enabled" },
        { type: "text", title: "About", at: [1, 6, 12, 3], text: "Changes take effect at once. Settings that must survive a restart need persistent variables in the program." },
      ],
    },
  },
};
