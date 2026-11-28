"""scikit-learn 1.9.1's public modules and their public names (tests/gen-names.py, from the oracle)."""

VERSION = '1.9.1'

MODULES = {
    'sklearn': (
        'calibration', 'callback', 'clone', 'cluster', 'compose', 'config_context', 'covariance',
        'cross_decomposition', 'datasets', 'decomposition', 'discriminant_analysis', 'dummy', 'ensemble',
        'exceptions', 'experimental', 'externals', 'feature_extraction', 'feature_selection', 'frozen',
        'gaussian_process', 'get_config', 'impute', 'inspection', 'isotonic', 'kernel_approximation', 'kernel_ridge',
        'linear_model', 'manifold', 'metrics', 'mixture', 'model_selection', 'multiclass', 'multioutput',
        'naive_bayes', 'neighbors', 'neural_network', 'pipeline', 'preprocessing', 'random_projection',
        'semi_supervised', 'set_config', 'show_versions', 'svm', 'tree',
    ),
    'sklearn.base': (
        'AttrsDict', 'BaseEstimator', 'BiclusterMixin', 'ClassNamePrefixFeaturesOutMixin', 'ClassifierMixin',
        'ClassifierTags', 'ClusterMixin', 'DensityMixin', 'InconsistentVersionWarning', 'MetaEstimatorMixin',
        'MultiOutputMixin', 'OneToOneFeatureMixin', 'OutlierMixin', 'ParamsDict', 'RegressorMixin', 'RegressorTags',
        'ReprHTMLMixin', 'Tags', 'TargetTags', 'TransformerMixin', 'TransformerTags', 'check_array',
        'check_is_fitted', 'clone', 'config_context', 'estimator_html_repr', 'get_config', 'get_tags',
        'is_classifier', 'is_clusterer', 'is_outlier_detector', 'is_pandas_na', 'is_regressor', 'is_scalar_nan',
        'validate_parameter_constraints',
    ),
    'sklearn.calibration': (
        'BaseEstimator', 'CalibratedClassifierCV', 'CalibrationDisplay', 'ClassifierMixin', 'FrozenEstimator',
        'HalfBinomialLoss', 'HalfMultinomialLoss', 'HalfMultinomialLossArrayAPI', 'HasMethods', 'Interval',
        'IsotonicRegression', 'LabelEncoder', 'LeaveOneOut', 'LinearSVC', 'MetaEstimatorMixin', 'MetadataRouter',
        'MethodMapping', 'Parallel', 'RegressorMixin', 'StrOptions', 'calibration_curve', 'check_array',
        'check_classification_targets', 'check_consistent_length', 'check_cv', 'check_is_fitted', 'clone',
        'column_or_1d', 'cross_val_predict', 'delayed', 'get_namespace', 'get_namespace_and_device', 'get_tags',
        'indexable', 'label_binarize', 'move_to', 'process_routing', 'softmax', 'validate_params',
    ),
    'sklearn.callback': (
        'AutoPropagatedCallback', 'CallbackContext', 'CallbackSupportMixin', 'FitCallback', 'ProgressBar',
        'ScoringMonitor', 'ScoringMonitorLog', 'with_callbacks',
    ),
    'sklearn.cluster': (
        'AffinityPropagation', 'AgglomerativeClustering', 'Birch', 'BisectingKMeans', 'DBSCAN',
        'FeatureAgglomeration', 'HDBSCAN', 'KMeans', 'MeanShift', 'MiniBatchKMeans', 'OPTICS', 'SpectralBiclustering',
        'SpectralClustering', 'SpectralCoclustering', 'affinity_propagation', 'cluster_optics_dbscan',
        'cluster_optics_xi', 'compute_optics_graph', 'dbscan', 'estimate_bandwidth', 'get_bin_seeds', 'k_means',
        'kmeans_plusplus', 'linkage_tree', 'mean_shift', 'spectral_clustering', 'ward_tree',
    ),
    'sklearn.compose': (
        'ColumnTransformer', 'TransformedTargetRegressor', 'make_column_selector', 'make_column_transformer',
    ),
    'sklearn.covariance': (
        'EllipticEnvelope', 'EmpiricalCovariance', 'GraphicalLasso', 'GraphicalLassoCV', 'LedoitWolf', 'MinCovDet',
        'OAS', 'ShrunkCovariance', 'empirical_covariance', 'fast_mcd', 'graphical_lasso', 'ledoit_wolf',
        'ledoit_wolf_shrinkage', 'log_likelihood', 'oas', 'shrunk_covariance',
    ),
    'sklearn.cross_decomposition': (
        'CCA', 'PLSCanonical', 'PLSRegression', 'PLSSVD',
    ),
    'sklearn.datasets': (
        'clear_data_home', 'dump_svmlight_file', 'fetch_20newsgroups', 'fetch_20newsgroups_vectorized',
        'fetch_california_housing', 'fetch_covtype', 'fetch_file', 'fetch_kddcup99', 'fetch_lfw_pairs',
        'fetch_lfw_people', 'fetch_olivetti_faces', 'fetch_openml', 'fetch_rcv1', 'fetch_species_distributions',
        'get_data_home', 'load_breast_cancer', 'load_diabetes', 'load_digits', 'load_files', 'load_iris',
        'load_linnerud', 'load_sample_image', 'load_sample_images', 'load_svmlight_file', 'load_svmlight_files',
        'load_wine', 'make_biclusters', 'make_blobs', 'make_checkerboard', 'make_circles', 'make_classification',
        'make_friedman1', 'make_friedman2', 'make_friedman3', 'make_gaussian_quantiles', 'make_hastie_10_2',
        'make_low_rank_matrix', 'make_moons', 'make_multilabel_classification', 'make_regression', 'make_s_curve',
        'make_sparse_coded_signal', 'make_sparse_spd_matrix', 'make_sparse_uncorrelated', 'make_spd_matrix',
        'make_swiss_roll',
    ),
    'sklearn.decomposition': (
        'DictionaryLearning', 'FactorAnalysis', 'FastICA', 'IncrementalPCA', 'KernelPCA', 'LatentDirichletAllocation',
        'MiniBatchDictionaryLearning', 'MiniBatchNMF', 'MiniBatchSparsePCA', 'NMF', 'PCA', 'SparseCoder', 'SparsePCA',
        'TruncatedSVD', 'dict_learning', 'dict_learning_online', 'fastica', 'non_negative_factorization',
        'randomized_svd', 'sparse_encode',
    ),
    'sklearn.discriminant_analysis': (
        'LinearDiscriminantAnalysis', 'QuadraticDiscriminantAnalysis',
    ),
    'sklearn.dummy': (
        'BaseEstimator', 'ClassifierMixin', 'DummyClassifier', 'DummyRegressor', 'Interval', 'MultiOutputMixin',
        'RegressorMixin', 'StrOptions', 'check_array', 'check_consistent_length', 'check_is_fitted',
        'check_random_state', 'class_distribution', 'validate_data',
    ),
    'sklearn.ensemble': (
        'AdaBoostClassifier', 'AdaBoostRegressor', 'BaggingClassifier', 'BaggingRegressor', 'BaseEnsemble',
        'ExtraTreesClassifier', 'ExtraTreesRegressor', 'GradientBoostingClassifier', 'GradientBoostingRegressor',
        'HistGradientBoostingClassifier', 'HistGradientBoostingRegressor', 'IsolationForest',
        'RandomForestClassifier', 'RandomForestRegressor', 'RandomTreesEmbedding', 'StackingClassifier',
        'StackingRegressor', 'VotingClassifier', 'VotingRegressor',
    ),
    'sklearn.exceptions': (
        'ConvergenceWarning', 'DataConversionWarning', 'DataDimensionalityWarning', 'EfficiencyWarning',
        'EstimatorCheckFailedWarning', 'FitFailedWarning', 'NotFittedError', 'PositiveSpectrumWarning',
        'SkipTestWarning', 'UndefinedMetricWarning', 'UnsetMetadataPassedError',
    ),
    'sklearn.feature_extraction': (
        'DictVectorizer', 'FeatureHasher', 'grid_to_graph', 'image', 'img_to_graph', 'text',
    ),
    'sklearn.feature_selection': (
        'GenericUnivariateSelect', 'RFE', 'RFECV', 'SelectFdr', 'SelectFpr', 'SelectFromModel', 'SelectFwe',
        'SelectKBest', 'SelectPercentile', 'SelectorMixin', 'SequentialFeatureSelector', 'VarianceThreshold', 'chi2',
        'f_classif', 'f_oneway', 'f_regression', 'mutual_info_classif', 'mutual_info_regression', 'r_regression',
    ),
    'sklearn.frozen': (
        'FrozenEstimator',
    ),
    'sklearn.gaussian_process': (
        'GaussianProcessClassifier', 'GaussianProcessRegressor', 'kernels',
    ),
    'sklearn.impute': (
        'KNNImputer', 'MissingIndicator', 'SimpleImputer',
    ),
    'sklearn.inspection': (
        'DecisionBoundaryDisplay', 'PartialDependenceDisplay', 'partial_dependence', 'permutation_importance',
    ),
    'sklearn.isotonic': (
        'IsotonicRegression', 'check_increasing', 'isotonic_regression',
    ),
    'sklearn.kernel_approximation': (
        'AdditiveChi2Sampler', 'BaseEstimator', 'ClassNamePrefixFeaturesOutMixin', 'Interval', 'Nystroem',
        'PolynomialCountSketch', 'RBFSampler', 'SkewedChi2Sampler', 'StrOptions', 'TransformerMixin',
        'check_is_fitted', 'check_random_state', 'get_namespace_and_device', 'pairwise_kernels', 'safe_sparse_dot',
        'validate_data',
    ),
    'sklearn.kernel_ridge': (
        'BaseEstimator', 'Interval', 'KernelRidge', 'MultiOutputMixin', 'RegressorMixin', 'StrOptions',
        'check_is_fitted', 'pairwise_kernels', 'validate_data',
    ),
    'sklearn.linear_model': (
        'ARDRegression', 'BayesianRidge', 'ElasticNet', 'ElasticNetCV', 'GammaRegressor', 'HuberRegressor', 'Lars',
        'LarsCV', 'Lasso', 'LassoCV', 'LassoLars', 'LassoLarsCV', 'LassoLarsIC', 'LinearRegression',
        'LogisticRegression', 'LogisticRegressionCV', 'MultiTaskElasticNet', 'MultiTaskElasticNetCV',
        'MultiTaskLasso', 'MultiTaskLassoCV', 'OrthogonalMatchingPursuit', 'OrthogonalMatchingPursuitCV',
        'PassiveAggressiveClassifier', 'PassiveAggressiveRegressor', 'Perceptron', 'PoissonRegressor',
        'QuantileRegressor', 'RANSACRegressor', 'Ridge', 'RidgeCV', 'RidgeClassifier', 'RidgeClassifierCV',
        'SGDClassifier', 'SGDOneClassSVM', 'SGDRegressor', 'TheilSenRegressor', 'TweedieRegressor', 'enet_path',
        'lars_path', 'lars_path_gram', 'lasso_path', 'orthogonal_mp', 'orthogonal_mp_gram', 'ridge_regression',
    ),
    'sklearn.manifold': (
        'ClassicalMDS', 'Isomap', 'LocallyLinearEmbedding', 'MDS', 'SpectralEmbedding', 'TSNE',
        'locally_linear_embedding', 'smacof', 'spectral_embedding', 'trustworthiness',
    ),
    'sklearn.metrics': (
        'ConfusionMatrixDisplay', 'DetCurveDisplay', 'DistanceMetric', 'PrecisionRecallDisplay',
        'PredictionErrorDisplay', 'RocCurveDisplay', 'accuracy_score', 'adjusted_mutual_info_score',
        'adjusted_rand_score', 'auc', 'average_precision_score', 'balanced_accuracy_score', 'brier_score_loss',
        'calinski_harabasz_score', 'check_scoring', 'class_likelihood_ratios', 'classification_report', 'cluster',
        'cohen_kappa_score', 'completeness_score', 'confusion_matrix', 'confusion_matrix_at_thresholds',
        'consensus_score', 'coverage_error', 'd2_absolute_error_score', 'd2_brier_score', 'd2_log_loss_score',
        'd2_pinball_score', 'd2_tweedie_score', 'davies_bouldin_score', 'dcg_score', 'det_curve',
        'euclidean_distances', 'explained_variance_score', 'f1_score', 'fbeta_score', 'fowlkes_mallows_score',
        'get_scorer', 'get_scorer_names', 'hamming_loss', 'hinge_loss', 'homogeneity_completeness_v_measure',
        'homogeneity_score', 'jaccard_score', 'label_ranking_average_precision_score', 'label_ranking_loss',
        'log_loss', 'make_scorer', 'matthews_corrcoef', 'max_error', 'mean_absolute_error',
        'mean_absolute_percentage_error', 'mean_gamma_deviance', 'mean_pinball_loss', 'mean_poisson_deviance',
        'mean_squared_error', 'mean_squared_log_error', 'mean_tweedie_deviance', 'median_absolute_error',
        'metric_at_thresholds', 'multilabel_confusion_matrix', 'mutual_info_score', 'nan_euclidean_distances',
        'ndcg_score', 'normalized_mutual_info_score', 'pair_confusion_matrix', 'pairwise_distances',
        'pairwise_distances_argmin', 'pairwise_distances_argmin_min', 'pairwise_distances_chunked',
        'pairwise_kernels', 'precision_recall_curve', 'precision_recall_fscore_support', 'precision_score',
        'r2_score', 'rand_score', 'recall_score', 'roc_auc_score', 'roc_curve', 'root_mean_squared_error',
        'root_mean_squared_log_error', 'silhouette_samples', 'silhouette_score', 'top_k_accuracy_score',
        'v_measure_score', 'zero_one_loss',
    ),
    'sklearn.metrics.pairwise': (
        'ArgKmin', 'DataConversionWarning', 'Hidden', 'Interval', 'MissingValues', 'Options', 'Parallel',
        'StrOptions', 'additive_chi2_kernel', 'check_array', 'check_non_negative', 'check_paired_arrays',
        'check_pairwise_arrays', 'chi2_kernel', 'config_context', 'cosine_distances', 'cosine_similarity', 'delayed',
        'distance_metrics', 'euclidean_distances', 'gen_batches', 'gen_even_slices', 'get_chunk_n_rows',
        'get_namespace', 'get_namespace_and_device', 'haversine_distances', 'is_scalar_nan', 'kernel_metrics',
        'laplacian_kernel', 'linear_kernel', 'manhattan_distances', 'nan_euclidean_distances', 'normalize',
        'paired_cosine_distances', 'paired_distances', 'paired_euclidean_distances', 'paired_manhattan_distances',
        'pairwise_distances', 'pairwise_distances_argmin', 'pairwise_distances_argmin_min',
        'pairwise_distances_chunked', 'pairwise_kernels', 'parse_version', 'polynomial_kernel', 'rbf_kernel',
        'row_norms', 'safe_sparse_dot', 'sigmoid_kernel', 'sp_base_version', 'validate_params',
    ),
    'sklearn.mixture': (
        'BayesianGaussianMixture', 'GaussianMixture',
    ),
    'sklearn.model_selection': (
        'BaseCrossValidator', 'BaseShuffleSplit', 'FixedThresholdClassifier', 'GridSearchCV', 'GroupKFold',
        'GroupShuffleSplit', 'HalvingGridSearchCV', 'HalvingRandomSearchCV', 'KFold', 'LearningCurveDisplay',
        'LeaveOneGroupOut', 'LeaveOneOut', 'LeavePGroupsOut', 'LeavePOut', 'ParameterGrid', 'ParameterSampler',
        'PredefinedSplit', 'RandomizedSearchCV', 'RepeatedKFold', 'RepeatedStratifiedKFold', 'ShuffleSplit',
        'StratifiedGroupKFold', 'StratifiedKFold', 'StratifiedShuffleSplit', 'TimeSeriesSplit',
        'TunedThresholdClassifierCV', 'ValidationCurveDisplay', 'check_cv', 'cross_val_predict', 'cross_val_score',
        'cross_validate', 'learning_curve', 'permutation_test_score', 'train_test_split', 'validation_curve',
    ),
    'sklearn.multiclass': (
        'OneVsOneClassifier', 'OneVsRestClassifier', 'OutputCodeClassifier',
    ),
    'sklearn.multioutput': (
        'ClassifierChain', 'MultiOutputClassifier', 'MultiOutputRegressor', 'RegressorChain',
    ),
    'sklearn.naive_bayes': (
        'BernoulliNB', 'CategoricalNB', 'ComplementNB', 'GaussianNB', 'MultinomialNB',
    ),
    'sklearn.neighbors': (
        'BallTree', 'KDTree', 'KNeighborsClassifier', 'KNeighborsRegressor', 'KNeighborsTransformer', 'KernelDensity',
        'LocalOutlierFactor', 'NearestCentroid', 'NearestNeighbors', 'NeighborhoodComponentsAnalysis',
        'RadiusNeighborsClassifier', 'RadiusNeighborsRegressor', 'RadiusNeighborsTransformer', 'VALID_METRICS',
        'VALID_METRICS_SPARSE', 'kneighbors_graph', 'radius_neighbors_graph', 'sort_graph_by_row_values',
    ),
    'sklearn.neural_network': (
        'BernoulliRBM', 'MLPClassifier', 'MLPRegressor',
    ),
    'sklearn.pipeline': (
        'FeatureUnion', 'Pipeline', 'make_pipeline', 'make_union',
    ),
    'sklearn.preprocessing': (
        'Binarizer', 'FunctionTransformer', 'KBinsDiscretizer', 'KernelCenterer', 'LabelBinarizer', 'LabelEncoder',
        'MaxAbsScaler', 'MinMaxScaler', 'MultiLabelBinarizer', 'Normalizer', 'OneHotEncoder', 'OrdinalEncoder',
        'PolynomialFeatures', 'PowerTransformer', 'QuantileTransformer', 'RobustScaler', 'SplineTransformer',
        'StandardScaler', 'TargetEncoder', 'add_dummy_feature', 'binarize', 'label_binarize', 'maxabs_scale',
        'minmax_scale', 'normalize', 'power_transform', 'quantile_transform', 'robust_scale', 'scale',
    ),
    'sklearn.random_projection': (
        'GaussianRandomProjection', 'SparseRandomProjection', 'johnson_lindenstrauss_min_dim',
    ),
    'sklearn.semi_supervised': (
        'LabelPropagation', 'LabelSpreading', 'SelfTrainingClassifier',
    ),
    'sklearn.svm': (
        'LinearSVC', 'LinearSVR', 'NuSVC', 'NuSVR', 'OneClassSVM', 'SVC', 'SVR', 'l1_min_c',
    ),
    'sklearn.tree': (
        'BaseDecisionTree', 'DecisionTreeClassifier', 'DecisionTreeRegressor', 'ExtraTreeClassifier',
        'ExtraTreeRegressor', 'export_graphviz', 'export_text', 'plot_tree',
    ),
    'sklearn.utils': (
        'Bunch', 'ClassifierTags', 'DataConversionWarning', 'InputTags', 'RegressorTags', 'Tags', 'TargetTags',
        'TransformerTags', 'all_estimators', 'as_float_array', 'assert_all_finite', 'check_X_y', 'check_array',
        'check_consistent_length', 'check_random_state', 'check_scalar', 'check_symmetric', 'column_or_1d',
        'compute_class_weight', 'compute_sample_weight', 'deprecated', 'estimator_html_repr', 'gen_batches',
        'gen_even_slices', 'get_tags', 'indexable', 'metadata_routing', 'murmurhash3_32', 'resample', 'safe_mask',
        'safe_sqr', 'shuffle',
    ),
    'sklearn.utils.multiclass': (
        'attach_unique', 'cached_unique', 'check_array', 'check_classification_targets', 'class_distribution',
        'get_namespace', 'is_multilabel', 'type_of_target', 'unique_labels',
    ),
    'sklearn.utils.validation': (
        'DataConversionWarning', 'FiniteStatus', 'NotFittedError', 'PositiveSpectrumWarning', 'as_float_array',
        'assert_all_finite', 'check_X_y', 'check_array', 'check_consistent_length', 'check_is_fitted', 'check_memory',
        'check_non_negative', 'check_random_state', 'check_scalar', 'check_symmetric', 'column_or_1d', 'cy_isfinite',
        'get_namespace', 'get_namespace_and_device', 'get_tags', 'has_fit_parameter', 'indexable',
        'is_pandas_df_or_series', 'move_to', 'validate_data',
    ),
}
