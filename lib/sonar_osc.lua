-- sonar_osc: OSC out and in for sonar (flora fork) and rain (raindrops fork)
--
-- out: every note, rest, generation, ruleset, active plant, page, envelope, heartbeat
-- in:  /sonar/* actions (below). /param/<id> is handled by norns itself.
--
-- contract: see README.md "OSC". All numbers are OSC floats or ints as noted.
-- nothing here touches audio. with `sonar_osc_enabled` off, every call returns early.

local sonar_osc = {}

sonar_osc.enabled = true
sonar_osc.ip = "192.168.1.100"
sonar_osc.port = 57120
sonar_osc.max_sentence = 8000
sonar_osc.hb_period = 1 -- seconds
sonar_osc.seq = 0
sonar_osc.sent = 0
sonar_osc.script = "sonar"

local hb_clock = nil
local prev_osc_event = nil
local last_page = nil
local last_active = nil

local function dest()
  return { sonar_osc.ip, sonar_osc.port }
end

function sonar_osc.send(path, args)
  if not sonar_osc.enabled then return end
  sonar_osc.sent = sonar_osc.sent + 1
  osc.send(dest(), path, args)
end

----------------------------------------------------------------------
-- out
----------------------------------------------------------------------

-- a plant played a note. x, y are norns screen pixels (128 x 64) or -1.
function sonar_osc.note(plant_id, idx, note, freq, x, y, dur)
  sonar_osc.send("/sonar/note", {
    plant_id, idx or 0, note or 0, freq or 0, x or -1, y or -1, dur or 0
  })
end

function sonar_osc.rest(plant_id, idx)
  sonar_osc.send("/sonar/rest", { plant_id, idx or 0 })
end

-- generation state of a flora plant object
function sonar_osc.gen(p)
  if not sonar_osc.enabled or not p then return end
  local sentence = ""
  local ok, s = pcall(p.get_sentence)
  if ok and type(s) == "string" then sentence = s end
  local truncated = 0
  if #sentence > sonar_osc.max_sentence then
    sentence = ""
    truncated = 1
  end
  local angle = 0
  local ok2, a = pcall(p.get_angle)
  if ok2 and a then angle = a end
  local x0 = (p.start_from and p.start_from.x) or 0
  local y0 = (p.start_from and p.start_from.y) or 0
  sonar_osc.send("/sonar/gen", {
    p.id, p.current_generation or 0, p.max_generations or 0,
    angle, p.length or 0, x0, y0, p.initial_turtle_rotation or 0,
    sentence, truncated
  })
end

-- axiom and rulesets of a flora plant object
function sonar_osc.rules(p)
  if not sonar_osc.enabled or not p then return end
  local args = { p.id, p.axiom or "" }
  local n = 0
  if type(p.ruleset) == "table" then
    for i = 1, #p.ruleset do
      local r = p.ruleset[i]
      local pred, succ
      if type(r) == "table" then
        -- flora rule objects expose get_a/get_b; catalog tables are {pred, succ}
        if r.get_a then pred = r.get_a() else pred = r[1] end
        if r.get_b then succ = r.get_b(p.current_generation or 1) else succ = r[2] end
      end
      if pred ~= nil then
        n = n + 1
        args[#args + 1] = tostring(pred)
        args[#args + 1] = tostring(succ or "")
      end
    end
  end
  table.insert(args, 3, n)
  sonar_osc.send("/sonar/rules", args)
end

function sonar_osc.plant(active)
  last_active = active
  sonar_osc.send("/sonar/plant", { active })
end

function sonar_osc.page(idx)
  last_page = idx
  sonar_osc.send("/sonar/page", { idx })
end

function sonar_osc.env(plant_id, level)
  sonar_osc.send("/sonar/env", { plant_id, level or 0 })
end

-- heartbeat: seq, bpm, script name; also echoes page and active plant when they change
function sonar_osc.hb()
  sonar_osc.seq = sonar_osc.seq + 1
  local bpm = 0
  local ok, t = pcall(clock.get_tempo)
  if ok and t then bpm = t end
  sonar_osc.send("/sonar/hb", { sonar_osc.seq, bpm, sonar_osc.script })
  if pages and pages.index and pages.index ~= last_page then
    sonar_osc.page(pages.index)
  end
  if active_plant and active_plant ~= last_active then
    sonar_osc.plant(active_plant)
  end
end

----------------------------------------------------------------------
-- in
----------------------------------------------------------------------

local function plant_by_arg(a)
  if type(plants) ~= "table" then return nil end
  local n = tonumber(a) or active_plant or 1
  return plants[n], n
end

local handlers = {}

-- /sonar/generate i:plant i:dir
handlers["/sonar/generate"] = function(args)
  local p = plant_by_arg(args[1])
  if not p then return end
  local dir = tonumber(args[2]) or 1
  p.generate(dir)
  if screen_dirty ~= nil then screen_dirty = true end
end

-- /sonar/reset  (k1+k3: both plants back to their original forms)
handlers["/sonar/reset"] = function(args)
  if type(plants) ~= "table" then return end
  for i = 1, #plants do
    if plants[i].set_instructions then plants[i].set_instructions(0) end
  end
  if screen_dirty ~= nil then screen_dirty = true end
end

-- /sonar/plant i:n
handlers["/sonar/plant"] = function(args)
  local n = tonumber(args[1])
  if not n or type(plants) ~= "table" or not plants[n] then return end
  if active_plant and active_plant ~= n and plants[active_plant].switch_active_plant then
    plants[active_plant].switch_active_plant()
  end
end

-- /sonar/sentence i:plant s:sentence
handlers["/sonar/sentence"] = function(args)
  local p = plant_by_arg(args[1])
  if not p or type(args[2]) ~= "string" then return end
  p.set_sentence(args[2])
  p.restart_rendering = true
  if screen_dirty ~= nil then screen_dirty = true end
end

-- /sonar/play i:0|1
handlers["/sonar/play"] = function(args)
  if type(plants) ~= "table" then return end
  local on = (tonumber(args[1]) or 1) == 1
  for i = 1, #plants do
    plants[i].playing = on
    if on and plants[i].start_playing then plants[i].start_playing() end
  end
  if not on and all_notes_off then all_notes_off() end
end

-- /sonar/resend: rules + gen for both plants, active plant, page
-- (a renderer that connects mid-show asks for the state it missed)
handlers["/sonar/resend"] = function(args)
  sonar_osc.resend()
end

-- /sonar/ping -> replies /sonar/pong to the sender
handlers["/sonar/ping"] = function(args, from)
  if from and from[1] then
    osc.send({ from[1], sonar_osc.port }, "/sonar/pong", { sonar_osc.script })
  end
end

function sonar_osc.event(path, args, from)
  local h = handlers[path]
  if h then
    local ok, err = pcall(h, args or {}, from)
    if not ok then print("sonar_osc: " .. tostring(err)) end
  end
  if prev_osc_event and prev_osc_event ~= sonar_osc.event then
    prev_osc_event(path, args, from)
  end
end

----------------------------------------------------------------------
-- params, init, cleanup
----------------------------------------------------------------------

function sonar_osc.add_params()
  params:add_group("sonar osc", 4)
  params:add_option("sonar_osc_enabled", "osc out", { "off", "on" }, 2)
  params:set_action("sonar_osc_enabled", function(x) sonar_osc.enabled = (x == 2) end)
  params:add_text("sonar_osc_ip", "osc ip", sonar_osc.ip)
  params:set_action("sonar_osc_ip", function(s) if s and #s > 0 then sonar_osc.ip = s end end)
  params:add_number("sonar_osc_port", "osc port", 1024, 65535, sonar_osc.port)
  params:set_action("sonar_osc_port", function(x) sonar_osc.port = x end)
  params:add_trigger("sonar_osc_resend", "resend state")
  params:set_action("sonar_osc_resend", function() sonar_osc.resend() end)
end

-- send rules + gen for every plant (on connect, on request)
function sonar_osc.resend()
  if type(plants) ~= "table" then return end
  for i = 1, #plants do
    sonar_osc.rules(plants[i])
    sonar_osc.gen(plants[i])
  end
  if active_plant then sonar_osc.plant(active_plant) end
  if pages and pages.index then sonar_osc.page(pages.index) end
end

function sonar_osc.init(script_name)
  sonar_osc.script = script_name or sonar_osc.script
  prev_osc_event = osc.event
  osc.event = sonar_osc.event
  if hb_clock then clock.cancel(hb_clock) end
  hb_clock = clock.run(function()
    while true do
      clock.sleep(sonar_osc.hb_period)
      sonar_osc.hb()
    end
  end)
end

function sonar_osc.cleanup()
  if hb_clock then clock.cancel(hb_clock); hb_clock = nil end
  if osc.event == sonar_osc.event then osc.event = prev_osc_event end
end

return sonar_osc
