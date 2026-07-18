---
name: OptiMesh Pro
colors:
  surface: '#131317'
  surface-dim: '#13131b'
  surface-bright: '#39393d'
  surface-container-lowest: '#0d0d15'
  surface-container-low: '#1b1b23'
  surface-container: '#1f1f27'
  surface-container-high: '#2a292d'
  surface-container-highest: '#353438'
  on-surface: '#e5e1e7'
  on-surface-variant: '#c7c5d0'
  inverse-surface: '#e5e1e7'
  inverse-on-surface: '#313034'
  outline: '#918f9a'
  outline-variant: '#464554'
  surface-tint: '#c0c1ff'
  primary: '#e1dfff'
  on-primary: '#292b5e'
  primary-container: '#c0c1ff'
  on-primary-container: '#4b4d83'
  inverse-primary: '#585990'
  secondary: '#c8c6c5'
  on-secondary: '#313030'
  secondary-container: '#474746'
  on-secondary-container: '#b7b5b4'
  tertiary: '#e5e2e1'
  on-tertiary: '#313030'
  tertiary-container: '#c9c6c5'
  on-tertiary-container: '#535252'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e1e0ff'
  primary-fixed-dim: '#c0c1ff'
  on-primary-fixed: '#131449'
  on-primary-fixed-variant: '#404176'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#e5e2e1'
  tertiary-fixed-dim: '#c9c6c5'
  on-tertiary-fixed: '#1c1b1b'
  on-tertiary-fixed-variant: '#474646'
  background: '#131317'
  on-background: '#e5e1e7'
  surface-variant: '#353438'
  success-green: '#4ade80'
  warning-amber: '#fbbf24'
  error-red: '#ffb4ab'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
  mono-sm:
    fontFamily: Geist
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-padding: 24px
  gutter: 16px
  toolbar-height: 48px
  sidebar-width: 280px
---

## Brand & Style
OptiMesh Pro is a technical, high-performance tool designed for 3D artists and technical directors. The brand personality is **Precise, Systematic, and Industrial**. 

The design style is **Modern Professional with Technical Accents**. It utilizes a "Dark Mode First" approach that minimizes eye strain during long optimization sessions. The aesthetic leans into a "Digital Workbench" feel, combining clean layouts with high-density data displays. Visual interest is generated through functional color-coding (status indicators) and subtle depth created by tonal layering rather than heavy shadows. It feels like a high-end CAD or DCC (Digital Content Creation) application, prioritizing utility and clarity.

## Colors
The palette is rooted in a deep "Midnight Obsidian" (`#13131b`) base, providing a high-contrast foundation for the primary "Electric Lavender" (`#c0c1ff`) accent color. 

- **Primary:** Used for active states, primary actions, and brand identification.
- **Surface Tiers:** Uses a strict hierarchy of dark grays to separate the viewport from control panels. Lower elevations (backgrounds) are darker, while interactive panels are slightly lighter.
- **Functional Accents:** Vibrant greens and reds are reserved strictly for status messaging (optimization success, memory warnings, or validation issues).
- **Outlines:** Low-contrast borders (`#464554`) are used instead of shadows to define boundaries in the dark UI.

## Typography
The system uses a dual-font approach to distinguish between content and data. 

- **Inter** handles the primary interface text, providing excellent legibility and a neutral, corporate feel.
- **Geist** (specifically the Monospace variant) is utilized for labels, technical stats, and console logs. This reinforces the "developer tool" aesthetic and ensures that numerical data (triangle counts, memory usage) is easy to scan.
- **Scale:** High density is prioritized. Most interface labels are 12px, while body text remains at 14px. Headlines are kept compact to maximize workspace for the 3D viewports.

## Layout & Spacing
The layout follows a **Fixed-Panel Fluid Workspace** model. 

- **Sidebars:** Left (Outliner) and Right (Inspector) are fixed at 280px to provide consistent control surfaces.
- **Main Workspace:** The central area is fluid, splitting into multiple viewports (Original vs. Optimized) with a draggable central divider.
- **Grid:** A tight 4px base unit ensures precision in panel alignment. 
- **Density:** Elements are packed tightly with 8px-12px internal padding to provide a "pro-app" density, allowing more controls to be visible at once without scrolling.
- **Breakpoints:** On tablet/mobile, the left outliner collapses into a hamburger menu, and the dual-viewport view switches to a single-view toggle.

## Elevation & Depth
Elevation is achieved through **Tonal Layering** and **Surface Contrast** rather than traditional shadows.

- **Level 0 (Background):** `#0d0d15` (lowest) for the very bottom of the stack (main canvas).
- **Level 1 (Side Panels):** `#1b1b23` (low) for primary navigation and sidebars.
- **Level 2 (Header/Inspector):** `#1f1f27` (container) for the top toolbar and inspector backgrounds.
- **Level 3 (Interactive Elements):** `#292932` (high) for cards and nested components.
- **Dividers:** 1px borders using `outline-variant` (`#464554`) clearly demarcate panels.
- **Glassmorphism:** Suble backdrop blurs (12px-16px) are used on viewport overlays to maintain legibility without obscuring the 3D mesh behind them.

## Shapes
The shape language is **Technical and Efficient**.

- **Small Components:** Checkboxes and small tags use a 4px radius (`rounded`).
- **Standard UI Elements:** Buttons and input fields use an 8px radius (`rounded-lg`).
- **Cards & Primary Actions:** Larger containers and the main "Optimize" button use a 12px radius (`rounded-xl`) to feel slightly more prominent and modern.
- **Viewport Dividers:** Vertical handles and progress bars use "Full" rounding (`9999px`) to denote interactive, draggable, or fluid elements.

## Components
- **Buttons:** Primary buttons are solid `primary` with `on-primary` text. Secondary buttons use `surface-container-high` with an `outline-variant` border.
- **Inspector Cards:** Actionable cards in the right sidebar use a subtle border that changes to `primary` on hover to indicate interactivity.
- **Viewports:** Must include a radial dot grid (`#34343d`) and a gradient overlay at the top for HUD (Heads-Up Display) legibility.
- **Inputs/Selects:** Dark backgrounds (`surface-container-lowest`) with 1px `outline-variant` borders. Focus states use a 1px `primary` ring.
- **Tree Items:** Use left-side border accents (2px `primary`) to show current selection, combined with a subtle background highlight (`secondary-container/10`).
- **Progress Bars:** Thin (4px) tracks with high-contrast `primary` fills, often accompanied by monospaced percentage text.