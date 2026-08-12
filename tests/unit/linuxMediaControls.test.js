"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ACTIONS,
  buildMprisInterface,
  buildMprisRootInterface,
} = require("../../app/linux/mediaControls");

test("MPRIS action surface is fixed and dispatches only supported controls", () => {
  const actions = [];
  const player = buildMprisInterface((action) => actions.push(action));
  const root = buildMprisRootInterface((action) => actions.push(action));

  player.methods.ToggleMicrophone[1](() => {});
  player.methods.LeaveMeeting[1](() => {});
  root.methods.Raise[1](() => {});

  assert.deepEqual(actions, ["toggle-microphone", "leave-meeting", "play"]);
  assert.equal(ACTIONS.has("decline-call"), true);
  assert.equal(ACTIONS.has("run-arbitrary-command"), false);
});

test("MPRIS methods acknowledge callbacks without requiring arguments", () => {
  let callbackCalled = false;
  const player = buildMprisInterface(() => {});
  player.methods.Play[1]((error) => {
    callbackCalled = true;
    assert.equal(error, null);
  });
  assert.equal(callbackCalled, true);
});
