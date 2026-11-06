#!/usr/bin/env bash
# render_garden_demos.sh · the four garden demo MP3s (software renders, not the norns)
set -e
cd "$(dirname "$0")/.."
R="node tools/render_garden.mjs"
$R docs/demos/garden_seed42_base_software-render_v01.mp3 '{"seed":42,"seconds":90,"bpm":90}'
$R docs/demos/garden_seed42_loops4_delay030_software-render_v01.mp3 '{"seed":42,"seconds":90,"bpm":90,"delay":0.3,"layers":[{"seed":7,"atBeat":8},{"seed":99,"atBeat":24},{"seed":1234,"atBeat":40},{"seed":31337,"atBeat":56}]}'
$R docs/demos/garden_seed42_arp-up-16_2oct_delay045_bpm100_software-render_v01.mp3 '{"seed":42,"seconds":90,"bpm":100,"delay":0.45,"arp":{"mode":"up","rate":"1/16","octaves":2},"layers":[{"seed":7,"atBeat":16}]}'
$R docs/demos/garden_seed42_growth2_c3-major-pentatonic_arp-updown-8_software-render_v01.mp3 '{"seed":42,"seconds":90,"bpm":84,"delay":0.25,"growth":2,"key":[48,"major pentatonic"],"arp":{"mode":"updown","rate":"1/8","octaves":2},"layers":[{"seed":2026,"atBeat":32}]}'
