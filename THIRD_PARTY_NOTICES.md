# Third-party notices

This integration ports to JavaScript the knowledge of the local API of the
ismartgate and GogoGate2 gateways held by the following project: the request
envelope (the JSON array, the AES-128-CBC key derivation of the ismartgate
family and the fixed key of the GogoGate2, the initialisation characters, the
token), the `info` and `activate` options, the field names of the answers
(doors, status, mode, sensors, activation codes), the "none" value of the
sensors and the error codes of the two families. No file is copied, and
nothing of it is installed at runtime; its notice is reproduced below in full,
as its licence asks.

## ismartgate

<https://github.com/bdraco/ismartgate> (version 5.0.2, the library of the
Home Assistant "Gogogate2 and ismartgate" integration)

```
MIT License

Copyright (c) 2019-2020, Robbie Van Gorkom
Copyright (c) 2021, J. Nick Koston

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LM1LC3N7/gladys-blebox, gladys-openevse and gladys-ikea

`src/publisher.js` (from gladys-ikea, through gladys-blebox),
`src/gate/http.js` (adapted from gladys-blebox) and the structure of
`src/app.js` and `src/store.js` (after gladys-blebox and gladys-openevse) come
from integrations of the same author, under the Apache License 2.0 of this
repository (the `LICENSE` file).
