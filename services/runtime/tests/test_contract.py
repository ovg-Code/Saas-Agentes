"""El release que genera el plano de control (TS) debe ser aceptado por el runtime (Python)."""

import json
from pathlib import Path

import jsonschema

from agentes_runtime.release import Release

from .conftest import ROOT

SCHEMA = json.loads((ROOT / "packages/agent-spec/schema/release.schema.json").read_text())


def test_fixture_cumple_el_json_schema(release_json):
    jsonschema.validate(release_json, SCHEMA)


def test_fixture_cumple_los_modelos_pydantic(release_json):
    release = Release.model_validate(release_json)
    assert release.tool("pedidos__reembolsar").approval == "ask"
    assert release.tool("pedidos__consultar").binding.kind == "http"
    # ida y vuelta sin pérdida (alias `in` de los parámetros incluido)
    assert Release.model_validate(json.loads(release.model_dump_json(by_alias=True))) == release
