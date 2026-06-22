## v4.1.0

### One map marker for nearby owner devices

**Viewing data from your own sensors is now easier and more pleasant**

Sensors that share the same Robonomics owner and sit within 3 km of each other are shown as one map marker instead of one dot per device ID. If the same owner has devices farther apart (e.g. in different cities), they keep separate markers — bundling is per location, not per owner globally.

This works for any owned sensors on the Robonomics network, including DIY builds, but is especially useful when one person runs several **[Altruist Air Quality Sensors](https://cyberpunks.shop)** — for example Urban outdoors and Insight indoors at the same place.

### Device icons on map markers

**Finding the sensor you need is quicker at a glance.**

To make the map easier and more pleasant to read, each marker now shows its device type — Urban, Insight, DIY, and so on.

### More informative sensor health warnings

**You can now see exactly which readings our algorithm flagged as unreliable.**

The warning has a cleaner design, appears only when the chart shows suspect data for the active tab, and the popup names the specific metrics that may be wrong.

### Dynamic sensor addresses

**Chart tooltips can now show the address for each reading.**

If a sensor moved during the period you are viewing (day, week, or month), the tooltip shows where each measurement was taken. The popup header uses the address from the sensor’s latest location.

### Unique meta tags when sharing

**Share a sensor page on social media or in messages with richer link previews.**

The page title includes the sensor’s address (or a short device ID), and the description names the measurement type you are viewing.

### Removed old export

**New upgraded export will come in next releases.**

The old export was not very useful it was global and hard to use.

### Tech note

- Fix: Address cashed and didn't changed after geo changing
- Feat: RosMan v2 migration
- Refactor: API requests reduced
- Refactor: IndexedDB rebuilt structure for better functionallity. Accounts, Sensors was retouched.


## v4.0.4

**Stories (new):**

- Feat: Add “Stories” flow for sensor owners (create story with icon + comment + explicit `date`)
- Feat: Submit stories as Robonomics datalog transactions
- Feat: Fetch and render recent stories in a header carousel via RoSeMAN API (`/api/v2/story/list`)
- Feat: Add “Stories for this day” banner in sensor chart (shows up to 3 newest stories for the selected day)
- UX: Story links open the correct sensor/day (supports `timestamp` fallback) and can suggest a relevant chart measurement based on story icon
- UX: Add ability to hide specific stories globally (feed + popup + sensor story lists) via a `(sensorId, timestamp)` denylist

**Blog (new):**

- Feat: Add Blog list page and individual post pages with SEO meta support
- Feat: Add Markdown-based blog posts with frontmatter (cover, tags, abstract, published flag)
- Feat: Add locale-aware date/relative time + reading-time formatting in blog UI
- Feat: Add auto-translation script for Markdown posts (`npm run autotranslate:md`)
- UX: Improve blog layout, tags, cover rendering, and external links behavior

**New pages**

- Added Where to buy page + Support page

**Styles / Layout:**

- Refactor: unify all text pages to a shared header pattern (`pagetext-header`, `pagetext-title`, `pagetext-subtitle`)
- Refactor: consolidate prose, table and code-block styles into `src/assets/styles/layout.css` (remove per-page duplicates)
- UX: hide horizontal scrollbars for small-screen tables while keeping swipe scrolling

**Bug fixes**

- Fixed db cache issues

v4.0.3

Added sensor type display (DYI, Urban, Insight), improved date and time selection UX in sensor popup, added ability to view week and month data in sensor analytics.

**Bug Fixes:**

- Fix: improve error handling in IndexedDB operations

**Performance Improvements:**

- Perf: improve IndexedDB caching for week/month timeline periods

**UI/UX Improvements:**

- Feat: add progress bar for week/month data loading in sensor analytics
- Feat: add Advanced sensor link sharing

**Refactoring:**

- Refactor: reorganize sensor components structure (move to tabs/widgets/controls folders)
- Refactor: extract Accordion component to reusable controls component
- Refactor: improve component organization and reduce prop drilling

**Infrastructure:**

- Chore: add release-it configuration for automated version management
- Chore: update version synchronization between package.json and git tags
- Docs: add RELEASE.md with release workflow documentation

v4.0.1-v4.0.2
Switch from yarn to npm, remove Pinia dependency, fix build issues

v4.0.0

Major refactoring: UI/UX improvements, code cleanup, and performance optimizations

**UI/UX Improvements:**

- Feat: Added automatic cleanup of outdated localStorage entries (aqi*cache*_, revgeo*addr*_)
- Feat: Added satellite map theme
- Feat: Redesigned bottom control panel with improved UX
- Feat: Restored messages layer functionality
- Remove: Removed "Support" button from header
- Remove: Removed "Where to get Altruist Indoor & Outdoor Sensor" promotional content from header and sensor popup
- Refactor: Improved sensors display logic in header - show details only when zeroGeoSensors exist

**Core Refactoring:**

- Refactor: Migrated from Pinia store to Vue 3 composables (useMap, useSensors, useMessages, useBookmarks, useAccounts)
- Refactor: Removed Pinia dependency from the project
- Refactor: Centralized marker update logic in Main.vue, removed code duplication
- Refactor: Made SensorPopup.vue a pure UI component, removed data fetching and complex state management
- Refactor: Optimized watcher logic to prevent circular dependencies and unnecessary updates

**Map and Markers:**

- Refactor: Improved marker coloring logic
- Refactor: Enhanced updating markers
- Refactor: Fixed active marker state preservation during icon updates
- Refactor: Unified map movement functions (`setview` → `moveMap`)
- Refactor: Improved map centering logic when sensor's popup opened

**Data Management:**

- Refactor: Made requests.js file for enreached get requests logic
- Refactor: Improved data fetching logic to reduce get requests
- Fix: replaced a request for max data (markers coloring in emote mode) with proper one

**Chart Optimizations:**

- Refactor: Centralized graph update logic in Chart.vue into single `updateChart` function
- Refactor: Simplified `buildSeriesArray` function with better readability
- Refactor: Removed unused Highcharts components (download symbol will be added when new functionality will be added)
- Refactor: Optimized computed properties and watchers in Chart.vue

**Code Cleanup:**

- Cleanup: Removed unused CSS styles
- Cleanup: Removed unused functions and variables related to support pricing (AltruistPromo)
- Cleanup: Removed unused imports (AltruistPromo, fetchJson)
- Cleanup: Added JSDoc comments to key functions

v3.0.0
Crucial changes that might affect forks: configuration refactoring

- Fix: timeline within points in a sensor's chart
- Refactor: new structure for the header
- Refactor: improved sensor's popup for small screens
- Fix: overflow width scrolling for a sensor's popup
- Feat: dark mode support
- Refactor: improved code for the 'Measurements' page
- Docs: new page about use cases of air sensor
- Feat: added units in chart
- Fix: removed update chart in 'Daily recap' mode (needs to be checked)
- Feat: combined Temperature and Humidity in one group
- Feat: added navigation icon
- Refactor: images paths structruzed better
- Feat: static pages prerender for SEO
- Refactor: Pinia store structure refactoring
- Refactor: no geo popup (slight redesign)
- Refactor: default measure type in config moved to "map section" added usage of the default measure from config
- Refactor: added using of Roseman api, instead of BroadCasting for getting sensors list
- Feat: limitation for geo in config (no zoom out or pan for outer space) - useful for forks
- Feat: limitation for Sensor Counter, now sows only counted sensors for limited by geo map - useful for forks
- Refactor: config structure
- Feat: condiguration for map themes now available
- Feat: AQI Index for individual sensors available
- Refactor: measurements colors more vivid
- Feat: in sensor popup added geo link - if you click it, you will get system map link (Google, Apple - depends on your device)
- Feat: AQI index coloring fr points and clusters

v2.1.6

- Feat: combined dust and noise values in the chart

v2.1.5

- Refactor: added in sensor's chart checking if data is duplicated
- Refactor: added as DEFAULT_MEASURE_TYPE PM 2.5 value
- Fix: Radiation naming fixed
- Feat: added release info and bage about Polkadot (added REPO_NAME in config)
- Fix: name of sensor removed reloading on new points in Realtime
- Feat: added CO₂ unit
- Fix: fixed units file (some syntax)

v2.1.4

- Feat: Added bookmark icon for bookmarked sensors on the map
- Feat: Altruit promo section added
- Style: Sensors count styling

v2.1.3
Hotfix testing release. Some trouble with cache

v2.1.2

- Fix: "Daily recap" date picked chart redrawing bug
- Refactor: updated name of project in package, removed some unnessecary logs to debug in console

v2.1.1
Hot fix for cache problem (blank screen)

v2.1.0

- Fix: Realtime glitch for Chart in sensor pop-up
- Fix: "Units of measurement" glith in sensor pop-up
- Fix: removed PWA for now (to fix blank page bug)
- Style: removed unnecessary titles and zoom for Highcharts
- Refactor: added VALID_DATA_PROVIDERS to config to escape wrong values for provider (took from localStorage or route) and store in one place titles for data providers
- Style: sensor pop-up rearranged sections
- Refactor: added DEFAULT_MEASURE_TYPE and checking for activeUnit taken from URL as a param
- Refactor: if no data for active type unit selected, show something available in the Chart (Sensor pop-up)
- Style: replaced unclear legends in a chart of snesor pop-up with human-readable ones
- Style: Units of measurement - rearranged and replaced names with human-readable ones
- Fix: tweaked Noise grades, PM2.5 grades, Radiation grades; added names for PM2.5 and PM10; added grades for Pressure

v2.0.1
Feat: In sensor's popup has been added switcher "Realtime / Daily recap"

v2.0.0

- Loading events for sensor pop-up
