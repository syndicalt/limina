import fs from "node:fs";
import {
  synthesizeTimberHallHouse,
  synthesizeTimberHallHouseV2,
} from "../src/architecture/building-program-synthesizer.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_architecture_building_program_replay FAIL: ${message}`);
}

const fixtures = [
  {
    label: "v1",
    path: "assets/buildings/programs/functional-hall-house-fb4-program-v1.json",
    synthesize: synthesizeTimberHallHouse,
    programHash: "sha256:1cbfc81387a074f9475abdfe15290c21b6fc4b7a9050fd3f5db6f5543bf41736",
    rulebookHash: "sha256:a4e0b41e72b343e51a98173f59f0f8c04cd8c04ec5e0c5da6bae3c18bf493336",
    candidates: [
      ["target/front-to-rear/left-wall", "sha256:2201c8506bb5b83ff4045ad5c4273ef2c66d4733658767ae04880ee6598f1675", "sha256:75be6be7e52b93e16a3eb078d37ff33adcc97c42780738fe9a2a40376c09279e"],
      ["target/front-to-rear/right-wall", "sha256:930d05292eb3865598d926b030e21c173a4bc3e645aeb2c2cde9cc7890549070", "sha256:349e0012f537752f415514eefe39a7a606c6efdb1f4aac87066f54d2d97d324c"],
      ["target/rear-to-front/left-wall", "sha256:09538816e8a2144c3901311aae4466b954bba8b3a53aff140b1ad6f3903bae42", "sha256:110295b4f4e53f28b8025866ea578c15cbe04e6d5a92b20f793e59088d1a6de6"],
    ],
  },
  {
    label: "v2",
    path: "assets/buildings/programs/functional-hall-house-fb4-program-v2.json",
    synthesize: synthesizeTimberHallHouseV2,
    programHash: "sha256:0773d3b74739ac574fd5edab9886ffda9dec83cade820135f4b3a7ca296aab3a",
    rulebookHash: "sha256:e7ce8d762533e3eaabaaad264f24a05c3ef49ec686049e4d57d314948eea4562",
    candidates: [
      ["target/front-to-rear/left-wall", "sha256:6386b8b76aca2b1bce020765fe70f74a39d12792573eb6a730367ccb5362780e", "sha256:179efa752343f12dec8aaf536b66248c07b3f86931253101fd009db8107f0fcf"],
      ["target/front-to-rear/right-wall", "sha256:3f93268d1833cc5cb7c4d37734b36aa1540094074124d26ceb71f94fc3dd9fe5", "sha256:f5e3eb07bbf13a1e3e81e952afead452ee81bfbfdd5242bab03dfef05bcdb2ba"],
      ["target/rear-to-front/left-wall", "sha256:ce0eb7df0a77f0c1c7259049ae38e1ddc7457549431c617410c5b3c063eae250", "sha256:b5a25f802d3e1a12218bd9956e2a68647e6e9f359026376d3251e65b57e0897e"],
    ],
  },
] as const;

for (const fixture of fixtures) {
  const result = fixture.synthesize(JSON.parse(fs.readFileSync(fixture.path, "utf8")) as never);
  assert(result.programHash === fixture.programHash, `${fixture.label} program hash drifted`);
  assert(result.rulebookHash === fixture.rulebookHash, `${fixture.label} rulebook hash drifted`);
  assert(result.acceptedDecisionCount === 4, `${fixture.label} accepted frontier drifted`);
  assert(result.candidates.length === fixture.candidates.length, `${fixture.label} ranked frontier length drifted`);
  for (const [index, expected] of fixture.candidates.entries()) {
    const candidate = result.candidates[index];
    assert(candidate?.decision.id === expected[0], `${fixture.label} candidate ${index} decision drifted`);
    assert(candidate.compiled.specHash === expected[1], `${fixture.label} candidate ${index} spec drifted`);
    assert(candidate.compiled.irHash === expected[2], `${fixture.label} candidate ${index} IR drifted`);
  }
}

console.log("p_architecture_building_program_replay OK: V1/V2 program, rulebook, ranked spec, and IR hashes remain exact");
