-- tools/norns_mock.lua
-- Headless norns: enough of the norns Lua environment to load a script,
-- run init(), step the clock and call redraw(). Real norns libraries are
-- used wherever they are pure Lua (paramset, musicutil, controlspec,
-- lattice, sequins, util, tabutil, ui, graph, envgraph, fileselect...).
-- C bindings (_norns.*) are stubs. screen.* calls are counted. engine.*
-- and osc.send calls are logged.
--
-- Globals expected before this file runs:
--   NORNS_LUA   path to a checkout of monome/norns, its lua/ folder
--   CODE_ROOT   folder that stands for dust/code/ (parent of the sonar repo)
--   DATA_ROOT   writable folder standing for dust/data/
--   SCRIPT_NAME e.g. "sonar" (used for norns.state.name)

local M = {}
M.log = { engine = {}, osc = {}, screen = {}, prints = {} }

package.path = NORNS_LUA .. "/?.lua;" .. NORNS_LUA .. "/lib/?.lua;" .. NORNS_LUA .. "/core/?.lua;"
  .. NORNS_LUA .. "/extn/?.lua;" .. package.path

-- quiet print, keep a copy
local real_print = print
print = function(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
  M.log.prints[#M.log.prints + 1] = table.concat(parts, "\t")
  if M.verbose then real_print(...) end
end

-- Windows host: os.execute goes to cmd.exe, which knows no `mkdir -p`, no
-- single quotes and no /dev/null. Translate mkdir; skip anything else (logged).
M.windows = package.config:sub(1, 1) == "\\"
if M.windows then
  local real_execute = os.execute
  os.execute = function(cmd)
    if not cmd then return true end
    local dir = cmd:match("^%s*mkdir%s+%-p%s+(.-)%s*$")
    if dir then
      dir = dir:gsub("^['\"]", ""):gsub("['\"]$", ""):gsub("/", "\\")
      return real_execute('if not exist "' .. dir .. '" mkdir "' .. dir .. '"')
    end
    M.log.prints[#M.log.prints + 1] = "MOCK skipped os.execute on windows: " .. cmd
    return nil
  end
end

-- any _norns.* C binding is a no-op returning nil
_norns = setmetatable({}, { __index = function() return function() end end })
_norns.osc = {}
_norns.execute = function(cmd)
  if M.windows then return "" end
  -- io.popen is unavailable in lupa; route through a temp file
  local tmp = DATA_ROOT .. "/_exec.out"
  os.execute(cmd .. " > '" .. tmp .. "' 2>/dev/null")
  local f = io.open(tmp, "r")
  if not f then return "" end
  local out = f:read("*a") or ""
  f:close()
  return out
end
_norns.clock = {}
_norns.clock_cancel = function() end
_norns.clock_schedule_sleep = function() end
_norns.clock_schedule_sync = function() end
_norns.clock_get_tempo = function() return 120 end
_norns.clock_get_time_beats = function() return M.beats or 0 end
_norns.screen_text_extents = function(s) return #tostring(s) * 5, 8 end

norns = {}
norns.version = { update = "mock" }
norns.state = {
  name = SCRIPT_NAME,
  shortname = SCRIPT_NAME,
  path = CODE_ROOT .. "/sonar/",
  data = DATA_ROOT .. "/" .. SCRIPT_NAME .. "/",
  pset_last = 1,
  clock = { tempo = 120, source = 1, link_quantum = 4, link_start_stop_sync = 1,
    midi_out = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 }, midi_in = 1, crow_out_div = 4, crow_in_div = 4 },
}
norns.pmap = { data = {}, add = function() end, remove = function() end, assign = function() end }
norns.enc = { sens = function() end, accel = function() end }
norns.menu = { status = function() return false end }
norns.script = { clear = function() end, load = function() end }
norns.encoders = { set_sens = function() end, set_accel = function() end }
norns.online = nil
norns.system_cmd = function() end
norns.try = function(f, ...) return pcall(f, ...) end
norns.rerun = function() end
_menu = { rebuild_params = function() end, mode = false, binarystates = { triggered = {}, on = {} } }

os.execute("mkdir -p '" .. norns.state.data .. "nursery'")

_path = {
  home = DATA_ROOT, code = CODE_ROOT .. "/", data = DATA_ROOT .. "/",
  audio = DATA_ROOT .. "/audio/", dust = DATA_ROOT .. "/", favorites = DATA_ROOT .. "/favorites",
}

-- include(): dust/code/<name>.lua
function include(file)
  local dirs = { CODE_ROOT .. "/" .. file .. ".lua", norns.state.path .. file .. ".lua" }
  for _, p in ipairs(dirs) do
    local f = io.open(p, "r")
    if f then f:close(); return dofile(p) end
  end
  error("include: not found: " .. file)
end

-- real pure libs
util = require "util"
tab = require "tabutil"
controlspec = require "controlspec"
paramset = require "paramset"
params = paramset.new("", "PARAMETERS")
params.write = function() end
params.read = function() end
params.default = function() end
params.list = function() return {} end

-- clock: real coroutine scheduler, stepped by M.step()
clock = require "clock"
M.beats = 0
M.pending = {} -- coro_id -> {kind, when}
local SLEEP, SYNC = 0, 1
local function schedule(id, kind, a, b)
  if kind == SLEEP then
    -- a sleep of 0 (or nil) still yields to the scheduler on norns; give it a tick
    local dt = (a or 0) * (clock.get_tempo() / 60)
    if dt < 1e-4 then dt = 1e-4 end
    M.pending[id] = { at = M.beats + dt }
  else
    local q = a or 1
    local offset = b or 0
    local nextq = (math.floor(M.beats / q + 1e-9) + 1) * q + offset
    if nextq <= M.beats then nextq = M.beats + q end
    M.pending[id] = { at = nextq }
  end
end
clock.resume = function(coro_id, ...)
  local coro = clock.threads[coro_id]
  if not coro then return end
  local ok, kind, a, b = coroutine.resume(coro, ...)
  if not ok then
    M.log.prints[#M.log.prints + 1] = "CLOCK ERROR: " .. tostring(kind)
    M.clock_error = M.clock_error or tostring(kind)
    clock.threads[coro_id] = nil
    return
  end
  if coroutine.status(coro) == "dead" then
    clock.threads[coro_id] = nil
    M.pending[coro_id] = nil
  else
    schedule(coro_id, kind, a, b)
  end
end
clock.cancel = function(coro_id) clock.threads[coro_id] = nil; M.pending[coro_id] = nil end
clock.get_tempo = function() return norns.state.clock.tempo end
clock.get_beats = function() return M.beats end
clock.get_beat_sec = function() return 60 / clock.get_tempo() end
clock.internal = setmetatable({ set_tempo = function(t) norns.state.clock.tempo = t end }, { __index = function() return function() end end })
clock.link = setmetatable({}, { __index = function() return function() end end })
clock.crow = setmetatable({}, { __index = function() return function() end end })
clock.midi = setmetatable({}, { __index = function() return function() end end })
clock.transport = {}
clock.tempo_change_handler = nil
-- advance until `beats` have passed, resuming due coroutines in time order
function M.step(beats)
  local target = M.beats + beats
  local guard = 0
  while true do
    local next_id, next_at = nil, target
    for id, p in pairs(M.pending) do
      if p.at <= next_at then next_id, next_at = id, p.at end
    end
    if not next_id then M.fire_due_metros(target); break end
    M.fire_due_metros(next_at)
    M.beats = next_at
    M.pending[next_id] = nil
    clock.resume(next_id)
    guard = guard + 1
    if guard > 200000 then error("clock runaway") end
  end
  M.beats = target
end

-- compat (norns builds Lua 5.3 with 5.2 compat)
math.pow = math.pow or function(a, b) return a ^ b end
math.atan2 = math.atan2 or function(y, x) return math.atan(y, x) end
math.ldexp = math.ldexp or function(m, e) return m * 2.0 ^ e end
math.cosh = math.cosh or function(x) return (math.exp(x) + math.exp(-x)) / 2 end
unpack = unpack or table.unpack

-- metro: real periodic events, fired by M.step() in beat time
metro = {}
M.metros = {}
local metro_id = 0
metro.init = function(arg, time, count)
  local m = { time = time or 1, count = count or -1, stage = 0 }
  if type(arg) == "function" then m.event = arg
  elseif type(arg) == "table" then m.event = arg.event; m.time = arg.time or m.time; m.count = arg.count or m.count end
  metro_id = metro_id + 1
  m.id = metro_id
  m.start = function(self_or_time, time2, count2)
    if type(self_or_time) == "number" then m.time = self_or_time end
    if time2 then m.time = time2 end
    if count2 then m.count = count2 end
    m.running = true
    m.next_at = M.beats + m.time * (clock.get_tempo() / 60)
    M.metros[m.id] = m
  end
  m.stop = function() m.running = false; M.metros[m.id] = nil end
  return m
end
metro.free = function(id) if M.metros[id] then M.metros[id].running = false; M.metros[id] = nil end end
metro.free_all = function() M.metros = {} end

function M.fire_due_metros(limit)
  -- fire every metro due at or before `limit`, in time order; returns true if any fired
  local fired = false
  while true do
    local nm, nat = nil, limit
    for _, m in pairs(M.metros) do
      if m.running and m.next_at <= nat then nm, nat = m, m.next_at end
    end
    if not nm then break end
    M.beats = nat
    nm.stage = nm.stage + 1
    nm.next_at = nat + nm.time * (clock.get_tempo() / 60)
    if nm.count > 0 and nm.stage > nm.count then nm.stop() end
    if nm.event then
      local ok, err = pcall(nm.event, nm.stage)
      if not ok then M.log.prints[#M.log.prints + 1] = "METRO ERROR: " .. tostring(err); M.metro_error = M.metro_error or tostring(err) end
    end
    fired = true
  end
  return fired
end

-- screen: counted
screen = setmetatable({}, { __index = function(t, k)
  return function(...)
    M.log.screen[k] = (M.log.screen[k] or 0) + 1
    if k == "line" or k == "line_rel" or k == "circle" then
      M.log.lines = (M.log.lines or 0) + 1
    end
    if k == "text_extents" then return 5 * #tostring(select(1, ...)), 8 end
    if k == "peek" then return "" end
  end
end })

-- engine: logged
engine = setmetatable({ name = nil }, { __index = function(t, k)
  return function(...)
    M.log.engine[#M.log.engine + 1] = { k, ... }
  end
end })
engine.load = function(name, cb) if cb then cb() end end
engine.list_commands = function() end

-- osc
osc = {}
osc.send = function(to, path, args)
  M.log.osc[#M.log.osc + 1] = { to = to, path = path, args = args or {} }
end
osc.send_crone = function() end
osc.event = nil

-- midi
local function midi_dev(name)
  return setmetatable({ name = name, port = 1, connected = true }, { __index = function() return function() end end })
end
midi = { vports = {}, devices = {} }
for i = 1, 16 do midi.vports[i] = { name = "none", device = nil, event = nil, connected = false } end
midi.connect = function(n) return midi_dev("mock midi " .. tostring(n or 1)) end
midi.to_msg = function(d) return { type = "cc", cc = d[2], val = d[3], ch = 1 } end
midi.to_data = function(m) return { 0xb0, m.cc or 0, m.val or 0 } end
midi.add = function() end
midi.remove = function() end
midi.update_devices = function() end
midi.update_clock_receive = function() end
midi.Message = {}

-- crow, softcut, audio, keyboard, hid, grid, arc
local function callable_any()
  local mt = {}
  mt.__call = function() end
  mt.__index = function() return setmetatable({}, mt) end
  return setmetatable({}, mt)
end
crow = setmetatable({ output = {}, input = {}, ii = callable_any() }, { __index = function() return function() end end })
for i = 1, 4 do
  crow.output[i] = setmetatable({ volts = 0, slew = 0, shape = "linear", action = "" },
    { __index = function() return function() end end, __call = function() end })
end
for i = 1, 2 do crow.input[i] = setmetatable({}, { __index = function() return function() end end }) end
crow.connected = function() return false end
crow.send = function() end

softcut = setmetatable({}, { __index = function() return function() end end })
audio = setmetatable({}, { __index = function() return function() end end })
keyboard = { ctrl = function() return false end, shift = function() return false end, alt = function() return false end,
  code = function() end, char = function() end, process = function() end, codes = {} }
hid = { vports = {}, connect = function() return setmetatable({}, { __index = function() return function() end end }) end }
grid = { vports = {}, connect = function() return setmetatable({}, { __index = function() return function() end end }) end }
arc = { vports = {}, connect = function() return setmetatable({}, { __index = function() return function() end end }) end }
poll = { set = function() return { start = function() end, stop = function() end } end }

-- system params norns adds at startup (needs midi stub above)
clock.add_params()
params:add_separator("mock_script_sep")

-- selection UIs: no-op
fileselect = { enter = function() end }
textentry = { enter = function() end }
listselect = { enter = function() end }

-- redraw timer helpers some scripts expect
redraw = redraw or function() end
enc = enc or function() end
key = key or function() end
cleanup = cleanup or function() end

return M
