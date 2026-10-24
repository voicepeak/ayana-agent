import pytest

from scripts.configure_mobile_services import gateway_url


@pytest.mark.parametrize("value", ["https://mobile.example.com/path", "https://key@example.com", "https://example.com?key=x", "http://example.com", "http://8.8.8.8", "ftp://example.com"])
def test_public_activation_rejects_unsafe_origins(value):
    with pytest.raises(ValueError):
        gateway_url(value)


def test_https_origin_and_explicit_lan_fallback():
    assert gateway_url("https://mobile.example.com/") == "https://mobile.example.com"
    assert gateway_url("http://192.168.1.3:17330") == "http://192.168.1.3:17330"
