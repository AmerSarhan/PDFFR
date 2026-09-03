# Quarterly Operations Review

## Executive Summary

Throughput rose 14% quarter over quarter while unit cost held flat. This document was produced natively, so every glyph carries an exact coordinate that the decompiler reads directly. No page image is ever rendered for this text.

**Bold lead-in.** The remainder of this sentence is regular weight and continues here.

## Key Actions

- Re-thread reading order across multi-column layouts
- Reconstruct tables from column alignment
- Flag scanned pages for OCR instead of guessing

## Regional Performance

| Region | Units | Change |
| ------ | ----- | ------ |
| North  | 4,210 | +12%   |
| South  | 3,880 | +9%    |
| West   | 5,120 | +18%   |

## Two-Column Analysis

Left column begins here and runs down the page in a narrow measure so that reading order must be re-threaded by geometry rather than by stream order. Each of these lines is emitted in the content stream in an interleaved way on purpose.

Right column text should come after all of the left column, not interleaved with it. An XY-cut on whitespace finds the gutter between the columns and orders them correctly. Footnote reference appears here. Second paragraph on the right side.
