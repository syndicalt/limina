import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mapSource = readFileSync(new URL("./map.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function assertEachMutationSchedules(source, endpoint, completionPattern, window = 700) {
  let offset = 0, count = 0;
  while ((offset = source.indexOf(endpoint, offset)) !== -1) {
    const tail = source.slice(offset, offset + window);
    assert.match(tail, completionPattern, `${endpoint} mutation at byte ${offset} has no projection-save completion`);
    count++;
    offset += endpoint.length;
  }
  assert(count > 0, `static gate found no ${endpoint} mutations`);
}

test("every structured place and marker mutation schedules a canonical projection save", () => {
  assertEachMutationSchedules(mapSource, 'postJSON("/api/edit-place"', /afterPlaceChange\(\)/);
  assertEachMutationSchedules(appSource, 'postJSON("/api/edit-place"', /scheduleMapSave\(\)/);
  assertEachMutationSchedules(mapSource, 'postJSON("/api/edit-location"', /afterMarkerChange\(\)/);
});

test("raw navigation-document lifecycle changes also schedule projection saves", () => {
  assert.match(appSource, /saveEditor[\s\S]*?navigationDoc[\s\S]*?scheduleMapSave\(\)/);
  assert.match(appSource, /deleteDoc[\s\S]*?navigationDoc[\s\S]*?scheduleMapSave\(\)/);
  assert.match(appSource, /NAVIGATION_DOC_KINDS\.has\(kind\)[^\n]*scheduleMapSave\(\)/);
});

test("all compile, peek, and editor handoff paths require a committed save result", () => {
  for (const action of ["Compile", "3D peek", "Camera preview", "Open in Editor"]) {
    assert(mapSource.includes(`requireCommittedMapSave(`) && mapSource.includes(`"${action}"`), `${action} lacks a freshness guard`);
  }
  assert.match(mapSource, /requireCommittedMapSave\(await flushMapSave\(\),"Compile"\)[\s\S]{0,300}postJSON\("\/api\/compile-map"/);
  assert.match(mapSource, /requireCommittedMapSave\(await flushMapSave\(\),"3D peek"\)[\s\S]{0,300}postJSON\("\/api\/peek"/);
  assert.match(mapSource, /requireCommittedMapSave\(await flushMapSave\(\),"Camera preview"\)[\s\S]{0,300}postJSON\("\/api\/peek"/);
});

test("noncanonical map rendering converts physical radius and minimum import span to local units", () => {
  assert.match(mapSource, /p\.radiusM\*upm\*mapScale/);
  const paintSource = readFileSync(new URL("./map-paint.js", import.meta.url), "utf8");
  assert.match(paintSource, /metersToTargetLength\(200\)/);
});
