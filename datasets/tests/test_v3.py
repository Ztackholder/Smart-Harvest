"""Synthetic-data and seven-day sensor fixture checks. Run: python -m pytest -q"""
import csv
import hashlib
import json
import subprocess
import sys
from collections import defaultdict
from datetime import date,datetime
from pathlib import Path

import pandas as pd
import pytest

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data/v3'
sys.path.insert(0,str(ROOT))
from generate_dataset import CORE,generate,crop_components,week_tag
from sensor_utils import aggregate


def read(name):
    with (DATA/name).open(encoding='utf-8',newline='') as f:return list(csv.DictReader(f))

def test_rows_and_columns():
    train, val, pool, tests=read('train.csv'),read('validation.csv'),read('training_pool_4500.csv'),read('test_inputs.csv')
    assert (len(train),len(val),len(pool),len(tests))==(3700,800,4500,752)
    assert list(train[0])==CORE
    assert 'actual_harvest_kg' not in tests[0]
    assert not (set(CORE)&{'sensor_source','data_origin','split'})
    t={r['planting_id'] for r in train};v={r['planting_id'] for r in val};z={r['planting_id'] for r in tests}
    assert len(t)==3700 and len(v)==800 and len(z)==752
    assert not(t&v or v&z or z&t)
    assert {r['planting_id'] for r in pool}==t|v
    assert all(r['actual_harvest_kg']!='' for r in pool)

def test_target_date_week_and_age():
    for row in read('training_pool_4500.csv')+read('test_inputs.csv'):
        plant=date.fromisoformat(row['planting_date'])
        pred=datetime.fromisoformat(row['prediction_at'])
        target=date.fromisoformat(row['target_harvest_date'])
        assert pred.utcoffset().total_seconds()==25200
        assert (pred.date()-plant).days==int(row['crop_age_days'])
        assert (target-pred.date()).days==int(row['days_until_target_harvest'])
        assert week_tag(target)==row['target_period']
        assert float(row['planted_area_m2'])>0 and int(row['plant_count'])>0
        assert float(row.get('actual_harvest_kg') or 0)>=0
        if row['air_temp_mean_7d_c'] and row['air_temp_max_7d_c']:
            assert float(row['air_temp_mean_7d_c'])<=float(row['air_temp_max_7d_c'])
        if row['humidity_mean_7d_pct']:
            assert 0<=float(row['humidity_mean_7d_pct'])<=100
        if row['soil_moisture_min_7d_pct']:
            assert 0<=float(row['soil_moisture_min_7d_pct'])<=float(row['soil_moisture_mean_7d_pct'])<=100

def test_outcome_events_match_labels_and_date_gaps():
    refs={r['planting_id']:r for r in read('training_pool_4500.csv')+read('test_ground_truth.csv')}
    ev=read('harvest_events.csv')
    sums=defaultdict(float);dates=defaultdict(list)
    for e in ev:
        assert e['planting_id'] in refs
        assert e['event_period']==week_tag(date.fromisoformat(e['harvested_at']))
        dates[e['planting_id']].append(e['harvested_at'])
        if e['event_period']==refs[e['planting_id']]['target_period']:
            sums[e['planting_id']]+=float(e['quantity_kg'])
    for pid,row in refs.items():
        assert abs(sums[pid]-float(row['actual_harvest_kg']))<=.02001
    tr=read('train.csv');val=read('validation.csv');test=read('test_inputs.csv')
    assert max(max(dates[p['planting_id']]) for p in tr)<min(r['prediction_at'][:10] for r in val)
    assert max(max(dates[p['planting_id']]) for p in val)<min(r['prediction_at'][:10] for r in test)

def test_join_and_scenario_coverage():
    refs=read('training_pool_4500.csv')+read('test_inputs.csv')
    ids={r['planting_id'] for r in refs}
    meta=read('train_metadata.csv')+read('validation_metadata.csv')+read('test_metadata.csv')
    assert ids=={r['planting_id'] for r in meta}
    assert len(meta)==len(ids)
    scenarios={r['scenario'] for r in meta}
    assert scenarios=={'complete_iot','soil_missing','weather_api_only','air_partial','manual_only','device_offline'}
    for r in meta:
        for measurement in ('temperature','humidity','soil'):
            ct=int(r[measurement+'_valid_slots'])
            assert 0<=ct<=672
            assert abs(ct/672-float(r[measurement+'_coverage']))<.0001
        assert r['status'] in {'SIMULATED','STALE'}
        assert r['source_is_real_hardware']=='False'

def test_generator_repeatable_and_import_no_side_effect(tmp_path):
    config=json.loads((ROOT/'config.json').read_text())
    for k,v in [('n_train',100),('n_validation',35),('n_test',30)]:config[k]=v
    a=generate(config,seed=123,profile='smoke');b=generate(config,seed=123,profile='smoke')
    assert a==b
    c=generate(config,seed=124,profile='smoke')
    assert a!=c
    code='import generate_dataset;import sensor_utils;print("import_ok")'
    p=subprocess.run([sys.executable,'-c',code],cwd=ROOT,capture_output=True,text=True)
    assert p.returncode==0 and 'import_ok' in p.stdout

def test_raw_sensor_aggregation_fixture():
    rows=read('fixtures/sensor_raw_fixture.csv')
    expected=json.loads((DATA/'fixtures/sensor_fixture_expected.json').read_text())
    end=expected['complete']['window_end_exclusive']
    for name,ref in expected.items():
        sub=[r for r in rows if r['sample_id']==name]
        actual=aggregate(sub,end)
        assert actual==ref
    assert expected['complete']['quality']['air_temperature_c']['valid_slots']==672
    assert expected['complete']['rejected']['duplicates']==1
    assert expected['complete']['rejected']['invalid']==1
    assert expected['complete']['rejected']['outside_window']==1
    assert expected['missing_interval']['air_temp_mean_7d_c'] is None
    assert expected['stale']['air_temp_mean_7d_c'] is None

def test_ground_truth_not_in_testing_inputs():
    tests=read('test_inputs.csv');gt=read('test_ground_truth.csv')
    assert len(gt)==len(tests)==752
    assert {r['planting_id'] for r in gt}=={r['planting_id'] for r in tests}
    assert all(float(r['actual_harvest_kg'])>=0 for r in gt)
    assert any(float(r['actual_harvest_kg'])==0 for r in gt)

def test_model_feature_contract_and_prediction():
    joblib=pytest.importorskip('joblib')
    from train import routed_predict,to_features
    bundle=joblib.load(ROOT/'artifacts/v3/model.joblib')
    assert bundle['selected_using']=='validation_only'
    assert bundle['target_type']=='normalized'
    assert len(bundle['routes']['full']['features'])==9
    assert all('actual_harvest_kg' not in r['features'] for r in bundle['routes'].values())
    tests=pd.read_csv(DATA/'test_inputs.csv').head(15)
    meta=pd.read_csv(DATA/'test_metadata.csv').head(15)
    pred,routes=routed_predict(bundle,tests,meta)
    assert len(pred)==15 and all(x>=0 for x in pred)
    unknown=tests.copy();unknown.loc[0,'crop_id']='NOT_SUPPORTED'
    pred2,routes2=routed_predict(bundle,unknown,meta)
    assert routes2[0]=='unavailable'
