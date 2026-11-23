// UI SDK web components for the filter form (#187): Combobox (Problem, Description),
// Checkbox (Exclude these descriptions) and Button (Apply, Reset).
// https://ui-sdk.dev/docs/web-components. Apache-2.0.
//
// Loaded from jsDelivr at one pinned version through the page's import map
// (js/vendor-importmap.json, merged into each page by stamp_assets.py). Each import
// registers its ui-* elements. The plain ES module files share one copy of
// @ui-sdk/core with @ui-sdk/web/agent, so an agent bridge created later on the page
// (createAgent) sees these components. filterform.js waits for the elements to be
// defined before it sets their properties.
import '@ui-sdk/web/combobox';
import '@ui-sdk/web/checkbox';
import '@ui-sdk/web/button';
