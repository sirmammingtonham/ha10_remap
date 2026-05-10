# ha10_remap

better remap tool for the varmilo ha10 because their web configurator is ass and only allows for swapping existing inputs (wtf is the point of having 6 extra buttons if you can't even assign more inputs to them)

reverse engineered the remapping protocol from the official web configurator, then created a small frontend that allows for full control of assigning arbitrary inputs to any of the buttons

clone the repo, install with `npm i`, run the server with `npm dev`, then navigate to http://localhost:5173/ and connect your controller to begin remapping

### limitations
it seems like their firmware does not fully support duplicate binds - the second button is very glitchy and doesn't register consistently. luckily if you only want to assign duplicate movement keys (crossup style) you can assign the stick movement inputs as functional duplicate movements
