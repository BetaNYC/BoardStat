function freezeConfig(config) {
  return Object.freeze({ ...config, center: Object.freeze(config.center), boards: Object.freeze(config.boards) });
}

// Verified union of borough/community_board pairs in both official datasets; nulls and global 0 Unspecified are excluded.
export const BOROUGHS = Object.freeze({
  bronx: freezeConfig({
    slug: "bronx",
    name: "The Bronx",
    datasetValue: "BRONX",
    defaultBoard: "01 BRONX",
    center: [40.8448, -73.8648],
    boards: [
      "01 BRONX", "02 BRONX", "03 BRONX", "04 BRONX", "05 BRONX", "06 BRONX", "07 BRONX",
      "08 BRONX", "09 BRONX", "10 BRONX", "11 BRONX", "12 BRONX", "26 BRONX", "27 BRONX",
      "28 BRONX", "Unspecified BRONX", "01 QUEENS",
    ],
  }),
  brooklyn: freezeConfig({
    slug: "brooklyn",
    name: "Brooklyn",
    datasetValue: "BROOKLYN",
    defaultBoard: "01 BROOKLYN",
    center: [40.6501, -73.9496],
    boards: [
      "01 BROOKLYN", "02 BROOKLYN", "03 BROOKLYN", "04 BROOKLYN", "05 BROOKLYN", "06 BROOKLYN",
      "07 BROOKLYN", "08 BROOKLYN", "09 BROOKLYN", "10 BROOKLYN", "11 BROOKLYN", "12 BROOKLYN",
      "13 BROOKLYN", "14 BROOKLYN", "15 BROOKLYN", "16 BROOKLYN", "17 BROOKLYN", "18 BROOKLYN",
      "55 BROOKLYN", "56 BROOKLYN", "Unspecified BROOKLYN",
    ],
  }),
  manhattan: freezeConfig({
    slug: "manhattan",
    name: "Manhattan",
    datasetValue: "MANHATTAN",
    defaultBoard: "07 MANHATTAN",
    center: [40.7831, -73.9712],
    boards: [
      "01 MANHATTAN", "02 MANHATTAN", "03 MANHATTAN", "04 MANHATTAN", "05 MANHATTAN", "06 MANHATTAN",
      "07 MANHATTAN", "08 MANHATTAN", "09 MANHATTAN", "10 MANHATTAN", "11 MANHATTAN", "12 MANHATTAN",
      "64 MANHATTAN", "Unspecified MANHATTAN", "08 BRONX",
    ],
  }),
  queens: freezeConfig({
    slug: "queens",
    name: "Queens",
    datasetValue: "QUEENS",
    defaultBoard: "01 QUEENS",
    center: [40.7282, -73.7949],
    boards: [
      "01 QUEENS", "02 QUEENS", "03 QUEENS", "04 QUEENS", "05 QUEENS", "06 QUEENS", "07 QUEENS",
      "08 QUEENS", "09 QUEENS", "10 QUEENS", "11 QUEENS", "12 QUEENS", "13 QUEENS", "14 QUEENS",
      "80 QUEENS", "81 QUEENS", "82 QUEENS", "83 QUEENS", "84 QUEENS", "QENB", "Unspecified QUEENS",
    ],
  }),
  statenisland: freezeConfig({
    slug: "statenisland",
    name: "Staten Island",
    datasetValue: "STATEN ISLAND",
    defaultBoard: "01 STATEN ISLAND",
    center: [40.5795, -74.1502],
    boards: [
      "01 STATEN ISLAND", "02 STATEN ISLAND", "03 STATEN ISLAND", "95 STATEN ISLAND", "SILC",
      "Unspecified STATEN ISLAND",
    ],
  }),
});

export function getBoroughConfig(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase().replaceAll(/[^a-z]/g, "");
  return Object.values(BOROUGHS).find((borough) => (
    borough.slug === normalized || borough.datasetValue.toLocaleLowerCase().replaceAll(/[^a-z]/g, "") === normalized
  ));
}
