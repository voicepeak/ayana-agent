from pathlib import Path
import pytest
from services.agent.config import Settings

ROOT = Path(__file__).resolve().parents[1]


def test_design_partial_update_preserves_other_design_and_voice_settings(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({'voice': {'voice_mode': 'sovits', 'model_gpt': 'my-model'},
                     'companion_ui': {'frame_width': 420, 'frame_height': 400, 'show_japanese': True}})
    settings.update({'companion_ui': {'font_size': 24, 'show_subtitles': False}})
    loaded = Settings(root=ROOT, data_root=tmp_path)
    assert loaded.values['companion_ui']['frame_width'] == 420
    assert loaded.values['companion_ui']['frame_height'] == 400
    assert loaded.values['companion_ui']['show_japanese'] is True
    assert loaded.values['companion_ui']['font_size'] == 24
    assert loaded.values['companion_ui']['show_subtitles'] is False
    assert loaded.values['voice']['model_gpt'] == 'my-model'


@pytest.mark.parametrize('design', [None, [], {'unknown': 1}, {'frame_width': 901},
    {'font_size': 27}, {'opacity': 101}, {'background_color': '#fff'}, {'background_color': 'url(x)'}, {'portrait_x': 4097}, {'portrait_y': -4097}, {'portrait_size': 159}, {'portrait_size': 641}, {'portrait_side': 'center'}, {'frame_height': 319}, {'frame_height': 721}, {'frame_height': True}, {'portrait_size': True}, {'portrait_range': []}, {'portrait_range': 'head'},
    {'show_subtitles': 0}, {'opacity': float('nan')}, {'background_mode': 'url'}, {'background_mode': []}])
def test_invalid_design_never_mutates_saved_configuration(tmp_path, design):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({'volume': .5})
    previous = settings.path.read_bytes()
    with pytest.raises(ValueError):
        settings.update({'companion_ui': design})
    assert settings.path.read_bytes() == previous
    assert settings.values == Settings(root=ROOT, data_root=tmp_path).values


def test_new_background_and_portrait_position_persist(tmp_path):
    settings = Settings(root=ROOT, data_root=tmp_path)
    settings.update({'companion_ui': {'opacity': 100, 'background_mode': 'solid', 'background_color': '#e6dfd0',
                                    'portrait_side': 'left', 'portrait_x': -35, 'portrait_y': 40}})
    loaded = Settings(root=ROOT, data_root=tmp_path).values['companion_ui']
    assert loaded['opacity'] == 100
    assert loaded['background_color'] == '#e6dfd0'
    assert loaded['portrait_side'] == 'left'
    assert loaded['portrait_x'] == -35
    assert loaded['portrait_y'] == 40
    settings.update({'companion_ui': {'background_mode': 'minimal'}})
    assert settings.values['companion_ui']['background_color'] == '#e6dfd0'
