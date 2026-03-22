# Overview

A live map of every tram, train, and bus in Victoria, Australia — updated in real time.

## What is it?

A top-down map that shows where public transport vehicles are right now. Trams, trains, and buses appear as moving dots on a map of Victoria, with positions pulled from the state's official real-time transport feed.

## Who is it for?

Public transport enthusiasts — people who enjoy watching the network move, spotting patterns, and seeing the system as a living thing rather than a timetable.

## What does it do?

It takes the real-time location of every active vehicle in Victoria's public transport network and plots them on a map. You open it, and you see the city's trams gliding down their routes, trains running between stations, and buses fanning out across the suburbs — all moving in real time.

If you open it in two browser windows side by side, every vehicle is in the same spot on both.

## Scale

At any given moment the map tracks roughly **2,000 vehicles**:

| Mode | Typical count | Area |
|---|---|---|
| Metro Train | ~90 | Melbourne metro |
| Tram | ~160 | Inner Melbourne |
| Bus | ~1,700 | All of Victoria |
| V/Line (regional train) | ~30 | All of Victoria |

## Data sources

**10 live feeds** from the official Victorian government transport data portal (opendata.transport.vic.gov.au):

- **Vehicle Positions** (4 feeds) — where every vehicle is right now
- **Trip Updates** (4 feeds) — predicted arrival times at upcoming stops
- **Service Alerts** (2 feeds, train + tram only) — disruptions, planned works, route changes

Plus the **GTFS Schedule** static dataset (~191 MB) for route names, colors, stop names, and route shape geometry.

All feeds update every **~30 seconds**. Between updates, the server calculates where each vehicle should be and streams smooth positions to every connected browser.

See [gtfs-vic.md](gtfs-vic.md) for the full feed analysis.
