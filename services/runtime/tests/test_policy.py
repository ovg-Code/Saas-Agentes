import pytest

from agentes_runtime.policy import autonomy_allows, decide


@pytest.mark.parametrize("level,expected", [
    ("L1", [False, False, False, False]),
    ("L2", [True, False, False, False]),
    ("L3", [True, True, False, False]),
    ("L4", [True, True, True, False]),
    ("L5", [True, True, True, True]),
])
def test_matriz_igual_que_policy_ts(level, expected):
    assert [autonomy_allows(t, level) for t in ("read", "write", "irreversible", "financial")] == expected


def test_tool_inexistente_se_rechaza(release):
    _, d = decide(release, "borrar_base_de_datos", {})
    assert d.action == "reject"


def test_argumentos_invalidos_se_rechazan(release):
    _, d = decide(release, "pedidos__consultar", {"numero": 1001})  # debe ser string
    assert d.action == "reject" and "argumentos inválidos" in d.reason


def test_financiera_pide_aprobacion(release):
    _, d = decide(release, "pedidos__reembolsar", {"numero": "1001", "body": {"motivo": "x"}})
    assert d.action == "ask"


def test_defensa_en_profundidad_ante_release_manipulado(release):
    tools = [t.model_copy(update={"approval": "auto"}) if t.name == "pedidos__reembolsar" else t for t in release.tools]
    tampered = release.model_copy(update={"tools": tools})
    _, d = decide(tampered, "pedidos__reembolsar", {"numero": "1001", "body": {"motivo": "x"}})
    assert d.action == "ask"
