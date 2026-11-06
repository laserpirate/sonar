-- required and included files

-- required for multiple files
MusicUtil = require "musicutil"
tabutil = require "tabutil"
listselect = require 'listselect'
textentry= require 'textentry'
fileselect = require 'fileselect'


-- required for flora.lua
UI = require "ui"
-- polls = include "sonar/lib/polls"

-- required for cloud.lua and save_load.lua
if util.file_exists(_path.code.."norns.online") then
  share=include("norns.online/lib/share")
end

-- required for lfos
Lattice = require 'lattice'


-- required for parameters.lua
cs = require 'controlspec'
w_slash = include("sonar/lib/w_slash")

-- required for multiple files
include("sonar/lib/midi_helper")
vector = include("sonar/lib/vector")
globals = include("sonar/lib/globals")
parameters = include("sonar/lib/parameters")
save_load = include("sonar/lib/save_load")
sharer = include("sonar/lib/cloud")
instructions = include("sonar/lib/instructions")
lfo = include("sonar/lib/hnds")


-- required for flora.lua
encoders_and_keys = include("sonar/lib/encoders_and_keys")
flora_pages = include("sonar/lib/flora_pages")
plant = include("sonar/lib/plant")
modify = include("sonar/lib/modify")
envelope = include("sonar/lib/envelope")
water = include("sonar/lib/water")

-- required for plant.lua
plant_sounds = include("sonar/lib/plant_sounds") 
sonar_osc = include("sonar/lib/sonar_osc")
-- l_system_instructions_default = include("sonar/lib/gardens/".."garden_default")
-- l_system_instructions_community = include("sonar/lib/gardens/".."garden_community")
garden = include("sonar/lib/gardens/garden")
garden_catalog = include("sonar/lib/gardens/garden_catalog_default")
l_system = include("sonar/lib/l_system")
turtle_class = include("sonar/lib/turtle")
matrix_stack = include("sonar/lib/matrix_stack")
rule = include("sonar/lib/rule")

-- required for plant_sounds.lua
plant_sounds_externals = include("sonar/lib/plant_sounds_externals") 

-- required for nb
nb =  include("sonar/lib/nb/lib/nb") 
-- required for modify.lua
-- fileselect = require 'fileselect'
-- textentry = require 'textentry'

-- required for envelope.lua
ArbGraph = include("sonar/lib/ArbitraryGraph")

-- required for water.lua
fields = include("sonar/lib/fields") 
decimal_to_fraction = include("sonar/lib/decimal_to_fraction") 

-- required for fields.lua
field_irrigation = include("sonar/lib/field_irrigation") 
field_layout = include("sonar/lib/field_layout") 

-- required for field_layout.lua
crop = include "sonar/lib/field_crop"

-- required for sequencing plant generations
p_gen_seq = include "sonar/lib/plant_gen_sequencer"

-- required for sequencing psets
pset_seq = include "sonar/lib/pset_sequencer"


s = require('sequins')
tl = require('timeline')

tt = include "sonar/lib/tinta"